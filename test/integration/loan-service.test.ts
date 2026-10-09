import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/types.js';
import { InvalidTransitionError } from '../../src/domain/loan.js';
import { createApprovedLoan, getAuditTrail, recordLedgerEntry, transitionLoan } from '../../src/loans/service.js';
import { startPostgres } from './postgres.js';

let db: Kysely<Database>;
let stop: () => Promise<void>;
beforeAll(async () => ({ db, stop } = await startPostgres()));
afterAll(async () => stop?.());

const newLoan = () => createApprovedLoan(db, { borrowerId: 'b-1', amountCents: 250_000n, actor: 'user:alice' });

describe('transitionLoan', () => {
  it('writes the status change and its audit event together', async () => {
    const loan = await newLoan();
    await transitionLoan(db, { loanId: loan.id, to: 'disbursing', actor: 'user:bob', action: 'test' });

    const trail = await getAuditTrail(db, loan.id);
    expect(trail.map((e) => [e.actor, e.from_status, e.to_status])).toEqual([
      ['user:alice', null, 'approved'],
      ['user:bob', 'approved', 'disbursing'],
    ]);
  });

  it('rejects illegal transitions and leaves no trace', async () => {
    const loan = await newLoan();
    await expect(
      transitionLoan(db, { loanId: loan.id, to: 'disbursed', actor: 'user:bob', action: 'test' }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await getAuditTrail(db, loan.id)).toHaveLength(1);
  });

  it('is a no-op when repeated, so activity retries do not duplicate audit events', async () => {
    const loan = await newLoan();
    const move = () => transitionLoan(db, { loanId: loan.id, to: 'disbursing', actor: 'user:bob', action: 'test' });
    await move();
    await move();
    expect(await getAuditTrail(db, loan.id)).toHaveLength(2);
  });

  it('serialises concurrent transitions on the same loan', async () => {
    const loan = await newLoan();
    await transitionLoan(db, { loanId: loan.id, to: 'disbursing', actor: 'user:bob', action: 'test' });
    const results = await Promise.allSettled([
      transitionLoan(db, { loanId: loan.id, to: 'disbursed', actor: 'user:a', action: 'race' }),
      transitionLoan(db, { loanId: loan.id, to: 'failed', actor: 'user:b', action: 'race' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('append-only tables', () => {
  it('refuses to update or delete audit events', async () => {
    const loan = await newLoan();
    await expect(sql`update audit_events set actor = 'user:mallory' where loan_id = ${loan.id}`.execute(db)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql`delete from audit_events where loan_id = ${loan.id}`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('writes a ledger entry once per idempotency key', async () => {
    const loan = await newLoan();
    const entry = { loanId: loan.id, kind: 'hold' as const, amountCents: 250_000n, idempotencyKey: `${loan.id}:hold` };
    expect(await recordLedgerEntry(db, entry)).toBe(true);
    expect(await recordLedgerEntry(db, entry)).toBe(false);
  });
});

describe('money precision', () => {
  it('stores and returns amounts beyond 2^53 exactly', async () => {
    const loan = await createApprovedLoan(db, { borrowerId: 'b-2', amountCents: 9_007_199_254_740_993n, actor: 'user:alice' });
    expect(loan.amount_cents).toBe(9_007_199_254_740_993n);
  });
});
