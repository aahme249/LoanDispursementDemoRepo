import type { Kysely, Transaction } from 'kysely';
import type { Database, Loan, AuditEvent, LedgerEntryKind } from '../db/types.js';
import { assertTransition, type LoanStatus } from '../domain/loan.js';

type Db = Kysely<Database> | Transaction<Database>;

export class LoanNotFoundError extends Error {
  override readonly name = 'LoanNotFoundError';
  constructor(readonly loanId: string) {
    super(`loan ${loanId} not found`);
  }
}

/** Who did something. Humans are `user:<id>`, automation is `system:<component>`. */
export type ActorId = `user:${string}` | `system:${string}`;

export async function createApprovedLoan(
  db: Kysely<Database>,
  input: { borrowerId: string; amountCents: bigint; actor: ActorId },
): Promise<Loan> {
  return db.transaction().execute(async (trx) => {
    const loan = await trx
      .insertInto('loans')
      .values({ borrower_id: input.borrowerId, amount_cents: input.amountCents, status: 'approved' })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditEvent(trx, {
      loanId: loan.id,
      actor: input.actor,
      action: 'loan.approved',
      fromStatus: null,
      toStatus: 'approved',
      metadata: { amountCents: loan.amount_cents.toString() },
    });
    return loan;
  });
}

/**
 * The only way a loan's status changes.
 *
 * - Row lock (`for update`) serialises concurrent transitions on the same loan.
 * - The state machine rejects illegal moves.
 * - The audit event commits in the same transaction as the status change, so the
 *   audit trail can never disagree with the data it describes.
 * - Re-requesting the current status is a no-op, which makes this safe to call
 *   from retried Temporal activities without duplicating audit events.
 */
export async function transitionLoan(
  db: Kysely<Database>,
  input: {
    loanId: string;
    to: LoanStatus;
    actor: ActorId;
    action: string;
    metadata?: Record<string, unknown>;
  },
): Promise<Loan> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('loans')
      .selectAll()
      .where('id', '=', input.loanId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new LoanNotFoundError(input.loanId);
    if (current.status === input.to) return current;

    assertTransition(current.status, input.to);

    const updated = await trx
      .updateTable('loans')
      .set({ status: input.to, updated_at: new Date() })
      .where('id', '=', input.loanId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditEvent(trx, {
      loanId: input.loanId,
      actor: input.actor,
      action: input.action,
      fromStatus: current.status,
      toStatus: input.to,
      metadata: input.metadata,
    });
    return updated;
  });
}

export async function recordAuditEvent(
  db: Db,
  input: {
    loanId: string;
    actor: ActorId;
    action: string;
    fromStatus?: LoanStatus | null;
    toStatus?: LoanStatus | null;
    metadata?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  await db
    .insertInto('audit_events')
    .values({
      loan_id: input.loanId,
      actor: input.actor,
      action: input.action,
      from_status: input.fromStatus ?? null,
      to_status: input.toStatus ?? null,
      metadata: input.metadata,
    })
    .execute();
}

/**
 * Append a ledger entry exactly once per idempotency key. A retry after a
 * crash between "wrote the row" and "reported success" becomes a no-op.
 * Returns true if this call wrote the entry.
 */
export async function recordLedgerEntry(
  db: Db,
  input: { loanId: string; kind: LedgerEntryKind; amountCents: bigint; idempotencyKey: string },
): Promise<boolean> {
  const inserted = await db
    .insertInto('ledger_entries')
    .values({
      loan_id: input.loanId,
      kind: input.kind,
      amount_cents: input.amountCents,
      idempotency_key: input.idempotencyKey,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

export async function getLoan(db: Db, loanId: string): Promise<Loan> {
  const loan = await db.selectFrom('loans').selectAll().where('id', '=', loanId).executeTakeFirst();
  if (!loan) throw new LoanNotFoundError(loanId);
  return loan;
}

export async function getAuditTrail(db: Db, loanId: string): Promise<AuditEvent[]> {
  return db
    .selectFrom('audit_events')
    .selectAll()
    .where('loan_id', '=', loanId)
    .orderBy('created_at', 'asc')
    .execute();
}
