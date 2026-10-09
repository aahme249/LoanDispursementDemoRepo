import { ActivityFailure, ApplicationFailure, proxyActivities } from '@temporalio/workflow';
// Type-only import: workflow code runs in Temporal's deterministic sandbox and
// must never load the database driver, the network, or the clock directly.
import type { Activities } from './activities.js';

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 5,
  },
});

export type DisbursementResult = { status: 'disbursed'; providerRef: string } | { status: 'failed'; reason: string };

/**
 * Orchestrates one loan disbursement. The workflow only decides *what* happens
 * next; every side effect is an activity. Temporal persists each step, so a
 * worker crash resumes exactly where it stopped instead of re-sending money.
 *
 * Compensation is deliberately scoped to the payout step. Once the rail has
 * confirmed the payout, a later failure (e.g. writing the final status) must
 * be retried until it succeeds, never "compensated" by releasing funds that
 * have already left.
 */
export async function disburseLoan(loanId: string): Promise<DisbursementResult> {
  const { amountCents } = await activities.startDisbursement(loanId);
  await activities.reserveFunds(loanId, amountCents);

  let providerRef: string;
  try {
    ({ providerRef } = await activities.sendPayout(loanId, amountCents));
  } catch (err) {
    const reason = failureReason(err);
    await activities.releaseFunds(loanId, amountCents);
    await activities.failDisbursement(loanId, reason);
    return { status: 'failed', reason };
  }

  await activities.completeDisbursement(loanId, providerRef);
  return { status: 'disbursed', providerRef };
}

function failureReason(err: unknown): string {
  if (err instanceof ActivityFailure && err.cause instanceof ApplicationFailure) {
    return err.cause.type ? `${err.cause.type}: ${err.cause.message}` : err.cause.message;
  }
  if (err instanceof Error) return err.message;
  return 'unknown failure';
}
