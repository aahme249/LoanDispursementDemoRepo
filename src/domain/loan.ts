/**
 * The loan lifecycle as an explicit state machine.
 *
 *   approved ──► disbursing ──► disbursed
 *                    │
 *                    └───────► failed
 *
 * Every status change in the system goes through `assertTransition`, so an
 * illegal jump (e.g. approved -> disbursed, skipping the payout) cannot happen
 * no matter which code path asks for it.
 */
export const LOAN_STATUSES = ['approved', 'disbursing', 'disbursed', 'failed'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

const TRANSITIONS = {
  approved: ['disbursing'],
  disbursing: ['disbursed', 'failed'],
  disbursed: [],
  failed: [],
} as const satisfies Record<LoanStatus, readonly LoanStatus[]>;

export function canTransition(from: LoanStatus, to: LoanStatus): boolean {
  return (TRANSITIONS[from] as readonly LoanStatus[]).includes(to);
}

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';
  constructor(
    readonly from: LoanStatus,
    readonly to: LoanStatus,
  ) {
    super(`illegal loan transition: ${from} -> ${to}`);
  }
}

export function assertTransition(from: LoanStatus, to: LoanStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: LoanStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
