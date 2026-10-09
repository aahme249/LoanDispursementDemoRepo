import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/types.js';
import { createApprovedLoan, getAuditTrail, getLoan } from '../../src/loans/service.js';
import { FakeRail } from '../../src/payments/rail.js';
import { createActivities } from '../../src/temporal/activities.js';
import { WORKFLOWS_PATH, disbursementWorkflowId } from '../../src/temporal/shared.js';
import { disburseLoan } from '../../src/temporal/workflows.js';
import { startPostgres } from './postgres.js';

let db: Kysely<Database>;
let stopDb: () => Promise<void>;
let env: TestWorkflowEnvironment;

beforeAll(async () => {
  ({ db, stop: stopDb } = await startPostgres());
  // Time-skipping: retry backoffs complete instantly instead of in real seconds.
  env = await TestWorkflowEnvironment.createTimeSkipping();
});
afterAll(async () => {
  await env?.teardown();
  await stopDb?.();
});

/** Runs one disbursement end to end against real Postgres and a scripted rail. */
async function disburse(rail: FakeRail) {
  const loan = await createApprovedLoan(db, { borrowerId: 'b-1', amountCents: 500_000n, actor: 'user:alice' });
  const taskQueue = `test-${loan.id}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: WORKFLOWS_PATH,
    activities: createActivities({ db, rail }),
  });
  const result = await worker.runUntil(
    env.client.workflow.execute(disburseLoan, {
      taskQueue,
      workflowId: disbursementWorkflowId(loan.id),
      args: [loan.id],
    }),
  );
  const ledger = await db
    .selectFrom('ledger_entries')
    .select(['kind', 'amount_cents'])
    .where('loan_id', '=', loan.id)
    .orderBy('created_at')
    .execute();
  return {
    result,
    loan: await getLoan(db, loan.id),
    ledger: ledger.map((e) => e.kind),
    trail: (await getAuditTrail(db, loan.id)).map((e) => e.action),
  };
}

describe('disburseLoan', () => {
  it('holds funds, pays out, and marks the loan disbursed', async () => {
    const { result, loan, ledger, trail } = await disburse(new FakeRail(['ok']));
    expect(result.status).toBe('disbursed');
    expect(loan.status).toBe('disbursed');
    expect(ledger).toEqual(['hold', 'payout']);
    expect(trail).toEqual(['loan.approved', 'disbursement.started', 'disbursement.completed']);
  });

  it('retries transient rail failures and pays exactly once', async () => {
    const rail = new FakeRail(['transient', 'transient', 'ok']);
    const { result, ledger } = await disburse(rail);
    expect(result.status).toBe('disbursed');
    expect(rail.calls).toHaveLength(3);
    expect(new Set(rail.calls.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(ledger).toEqual(['hold', 'payout']);
  });

  it('does not retry a rejection; releases the hold and fails the loan', async () => {
    const rail = new FakeRail(['rejected']);
    const { result, loan, ledger, trail } = await disburse(rail);
    expect(result).toEqual({ status: 'failed', reason: 'PayoutRejected: beneficiary account closed' });
    expect(rail.calls).toHaveLength(1);
    expect(loan.status).toBe('failed');
    expect(ledger).toEqual(['hold', 'release']);
    expect(trail).toEqual(['loan.approved', 'disbursement.started', 'disbursement.failed']);
  });
});
