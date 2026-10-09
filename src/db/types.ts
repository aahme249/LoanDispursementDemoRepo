import type { ColumnType, Generated, Selectable } from 'kysely';
import type { LoanStatus } from '../domain/loan.js';

/**
 * Hand-written table types. Kysely checks every query against these at compile time.
 *
 * Money is stored as integer cents in a Postgres `bigint` and surfaced as a JS `bigint`
 * (see the type parser in client.ts). Never floats.
 *
 * ColumnType<Select, Insert, Update>: `never` means "the app may not write this column".
 * That encodes rules like "a loan's amount is immutable" and "the DB owns timestamps"
 * in the type system rather than in code review.
 */
export interface LoansTable {
  id: Generated<string>;
  borrower_id: string;
  amount_cents: ColumnType<bigint, bigint, never>;
  status: LoanStatus;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, Date>;
}

export type LedgerEntryKind = 'hold' | 'release' | 'payout';

export interface LedgerEntriesTable {
  id: Generated<string>;
  loan_id: string;
  kind: LedgerEntryKind;
  amount_cents: ColumnType<bigint, bigint, never>;
  /** Unique. Makes every ledger write safe to retry. */
  idempotency_key: string;
  created_at: ColumnType<Date, never, never>;
}

export interface AuditEventsTable {
  id: Generated<string>;
  loan_id: string;
  actor: string;
  action: string;
  from_status: LoanStatus | null;
  to_status: LoanStatus | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>;
  created_at: ColumnType<Date, never, never>;
}

export interface Database {
  loans: LoansTable;
  ledger_entries: LedgerEntriesTable;
  audit_events: AuditEventsTable;
}

export type Loan = Selectable<LoansTable>;
export type LedgerEntry = Selectable<LedgerEntriesTable>;
export type AuditEvent = Selectable<AuditEventsTable>;
