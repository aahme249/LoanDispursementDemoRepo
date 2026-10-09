import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/api/auth.js';
import { appRouter } from '../../src/api/router.js';
import { createCallerFactory, type Context } from '../../src/api/trpc.js';
import type { Database } from '../../src/db/types.js';
import { startPostgres } from './postgres.js';

let db: Kysely<Database>;
let stop: () => Promise<void>;
beforeAll(async () => ({ db, stop } = await startPostgres()));
afterAll(async () => stop?.());

const started: string[] = [];
const fakeTemporal = {
  workflow: { start: async (_wf: unknown, opts: { workflowId: string }) => void started.push(opts.workflowId) },
} as unknown as Context['temporal'];

// Callers are built lazily: `db` only exists once beforeAll has run.
const as = (actor: Actor | null) => createCallerFactory(appRouter)({ db, temporal: fakeTemporal, actor });
const underwriter = () => as({ id: 'user:alice', role: 'underwriter' });
const ops = () => as({ id: 'user:bob', role: 'disbursement_ops' });
const auditor = () => as({ id: 'user:carol', role: 'auditor' });

describe('access control', () => {
  it('rejects unauthenticated callers', async () => {
    await expect(as(null).loan.get({ loanId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('enforces separation of duties: underwriters cannot disburse', async () => {
    const loan = await underwriter().loan.approve({ borrowerId: 'b-1', amountCents: '100000' });
    await expect(underwriter().loan.disburse({ loanId: loan.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('auditors can read but not write', async () => {
    await expect(auditor().loan.approve({ borrowerId: 'b-1', amountCents: '100' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('disburse', () => {
  it('records who requested it and starts one workflow per loan', async () => {
    const loan = await underwriter().loan.approve({ borrowerId: 'b-1', amountCents: '100000' });
    const { workflowId } = await ops().loan.disburse({ loanId: loan.id });

    expect(started).toContain(workflowId);
    const trail = await auditor().loan.auditTrail({ loanId: loan.id });
    expect(trail.map((e) => [e.actor, e.action])).toEqual([
      ['user:alice', 'loan.approved'],
      ['user:bob', 'disbursement.requested'],
    ]);
  });

  it('returns NOT_FOUND for unknown loans', async () => {
    await expect(ops().loan.disburse({ loanId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('input validation', () => {
  it.each(['0', '12.50', 'abc'])('rejects amount %j', async (amountCents) => {
    await expect(underwriter().loan.approve({ borrowerId: 'b-1', amountCents })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
