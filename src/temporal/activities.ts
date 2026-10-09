import { ApplicationFailure } from '@temporalio/activity';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { parseCents, toCentsString, type CentsString } from '../domain/money.js';
import { PayoutRejectedError, type PaymentRail } from '../payments/rail.js';
import { recordLedgerEntry, transitionLoan } from '../loans/service.js';
import { WORKFLOW_ACTOR } from './shared.js';

/**
 * Activities are where side effects live. Temporal may run any of them more than
 * once (worker crash, timeout, retry), so every one is idempotent:
 *  - status changes are no-ops when already in the target state;
 *  - ledger writes are keyed by a deterministic idempotency key;
 *  - the payout forwards an idempotency key the rail deduplicates on.
 *
 * Keys are derived from the loan id because a loan has exactly one disbursement.
 * Money crosses the workflow boundary as a CentsString (Temporal payloads are JSON).
 */
export function createActivities(deps: { db: Kysely<Database>; rail: PaymentRail }) {
  const { db, rail } = deps;

  return {
    async startDisbursement(loanId: string): Promise<{ amountCents: CentsString }> {
      const loan = await transitionLoan(db, {
        loanId,
        to: 'disbursing',
        actor: WORKFLOW_ACTOR,
        action: 'disbursement.started',
      });
      return { amountCents: toCentsString(loan.amount_cents) };
    },

    async reserveFunds(loanId: string, amountCents: CentsString): Promise<void> {
      await recordLedgerEntry(db, {
        loanId,
        kind: 'hold',
        amountCents: parseCents(amountCents),
        idempotencyKey: `${loanId}:hold`,
      });
    },

    async sendPayout(loanId: string, amountCents: CentsString): Promise<{ providerRef: string }> {
      const idempotencyKey = `${loanId}:payout`;
      try {
        const result = await rail.send({ loanId, amountCents: parseCents(amountCents), idempotencyKey });
        await recordLedgerEntry(db, { loanId, kind: 'payout', amountCents: parseCents(amountCents), idempotencyKey });
        return result;
      } catch (err) {
        if (err instanceof PayoutRejectedError) {
          // Tell Temporal not to retry: the rail's answer will not change.
          throw ApplicationFailure.nonRetryable(err.message, 'PayoutRejected');
        }
        throw err; // transient: let the retry policy handle it
      }
    },

    async releaseFunds(loanId: string, amountCents: CentsString): Promise<void> {
      await recordLedgerEntry(db, {
        loanId,
        kind: 'release',
        amountCents: parseCents(amountCents),
        idempotencyKey: `${loanId}:release`,
      });
    },

    async completeDisbursement(loanId: string, providerRef: string): Promise<void> {
      await transitionLoan(db, {
        loanId,
        to: 'disbursed',
        actor: WORKFLOW_ACTOR,
        action: 'disbursement.completed',
        metadata: { providerRef },
      });
    },

    async failDisbursement(loanId: string, reason: string): Promise<void> {
      await transitionLoan(db, {
        loanId,
        to: 'failed',
        actor: WORKFLOW_ACTOR,
        action: 'disbursement.failed',
        metadata: { reason },
      });
    },

  };
}

export type Activities = ReturnType<typeof createActivities>;
