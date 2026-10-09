import { describe, expect, it } from 'vitest';
import { LOAN_STATUSES, InvalidTransitionError, assertTransition, canTransition, isTerminal } from '../../src/domain/loan.js';
import { parseCents, toCentsString } from '../../src/domain/money.js';

describe('loan state machine', () => {
  it.each([
    ['approved', 'disbursing'],
    ['disbursing', 'disbursed'],
    ['disbursing', 'failed'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('rejects skipping the payout step', () => {
    expect(() => assertTransition('approved', 'disbursed')).toThrow(InvalidTransitionError);
  });

  it('never leaves a terminal state', () => {
    for (const from of LOAN_STATUSES.filter(isTerminal)) {
      for (const to of LOAN_STATUSES) expect(canTransition(from, to)).toBe(false);
    }
  });
});

describe('money', () => {
  it('round-trips amounts beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const big = '90071992547409930';
    expect(toCentsString(parseCents(big))).toBe(big);
  });

  it.each(['0', '-5', '12.50', '1e3', '', ' 100', '0100'])('rejects %j', (bad) => {
    expect(() => parseCents(bad)).toThrow(RangeError);
  });
});
