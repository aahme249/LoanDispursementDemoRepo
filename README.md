# loan-disbursement-demo

A small service that disburses approved loans, built to show how I approach
money-movement code in a regulated setting: **every state change is audited,
every side effect is idempotent, and access is deny-by-default.**

**Stack:** TypeScript (strict) · Node 22 · Hono · tRPC · Kysely · PostgreSQL · Temporal · Vitest · testcontainers · GitLab CI

## What it does

```
underwriter ──approve──► loan (approved)
                              │
disbursement_ops ──disburse──►│  Temporal workflow: disburseLoan
                              ▼
                  reserve funds (ledger hold)
                              │
                  send payout to payment rail ──rejected──► release hold ─► loan failed
                              │ transient errors: retried with backoff
                              ▼
                        loan disbursed
```

An auditor can read any loan's full audit trail: who did what, when, and which
status it moved from and to.

## Design decisions

**Status changes go through one function.** `transitionLoan` locks the row
(`select … for update`), checks an explicit state machine, updates the status,
and writes the audit event, all in one transaction. The audit trail cannot
disagree with the data it describes, and an illegal jump like
`approved → disbursed` is rejected no matter which code path asks.

**Audit and ledger tables are append-only, enforced by Postgres.** A trigger
rejects `UPDATE` and `DELETE`. This is a database guarantee, not a convention
that a future change could quietly break.

**Every side effect is idempotent.** Temporal can run an activity more than
once (crash, timeout, retry). Ledger writes carry a deterministic idempotency
key backed by a unique constraint. Payouts forward the same key to the rail.
Re-requesting the current status is a no-op, so retries don't duplicate audit
events. A test sends two transient failures, then success, and asserts exactly
one payout.

**Workflow code only orchestrates.** `workflows.ts` has no database, network,
or clock access; it imports activity *types* only. That keeps it deterministic
so Temporal can replay it, and a bundling check confirms the database driver
never enters the workflow sandbox.

**Retryable vs. non-retryable failures are explicit.** A timeout from the rail
is retried with exponential backoff. A definitive rejection (closed account) is
raised as a non-retryable `ApplicationFailure`, since retrying won't change the
answer, and triggers compensation.

**Compensation is scoped to the payout step only.** If the payout succeeds but
writing the final status fails, the workflow retries that write; it never
"compensates" by releasing funds that have already left. The `try` block wraps
exactly one call for this reason.

**Money is integer cents.** Stored as Postgres `bigint`, parsed to JS `bigint`
(the `pg` default is a string that invites `Number()` and precision loss). It
crosses JSON boundaries (HTTP, Temporal payloads) as a validated decimal
string. A test round-trips an amount above 2^53.

**Separation of duties.** Roles are `underwriter` (approve),
`disbursement_ops` (disburse) and `auditor` (read). The person who approves a
loan cannot release its money. Every procedure names exactly which roles may
call it.

**Types encode rules.** Kysely's `ColumnType<Select, Insert, Update>` marks
`amount_cents` as never-updatable and timestamps as DB-owned, so violations
fail at compile time.

**Tests hit real Postgres.** No database mocks. Each test file gets a freshly
migrated database, either through testcontainers or, when `TEST_DATABASE_URL`
is set, as a throwaway database on an existing server (used in CI).

## Running it

Requirements: Node 22, Docker, and the [Temporal CLI](https://docs.temporal.io/cli).

```bash
npm install
cp .env.example .env && export $(cat .env | xargs)

npm run db:up                  # Postgres in Docker
temporal server start-dev      # Temporal dev server, UI at http://localhost:8233
npm run migrate

npm run worker                 # terminal 1
npm run api                    # terminal 2
```

Try it (identity comes from demo headers; see `src/api/auth.ts`):

```bash
# Approve a $2,500.00 loan as an underwriter
curl -s localhost:3000/trpc/loan.approve \
  -H 'content-type: application/json' \
  -H 'x-actor-id: alice' -H 'x-actor-role: underwriter' \
  -d '{"borrowerId":"b-1","amountCents":"250000"}'

# Disburse it as ops (an underwriter gets FORBIDDEN)
curl -s localhost:3000/trpc/loan.disburse \
  -H 'content-type: application/json' \
  -H 'x-actor-id: bob' -H 'x-actor-role: disbursement_ops' \
  -d '{"loanId":"<id from above>"}'

# Read the audit trail as an auditor
curl -s -G localhost:3000/trpc/loan.auditTrail \
  -H 'x-actor-id: carol' -H 'x-actor-role: auditor' \
  --data-urlencode 'input={"loanId":"<id>"}'
```

## Tests

```bash
npm run test:unit   # state machine and money parsing, no infrastructure
npm test            # everything; needs Docker (or TEST_DATABASE_URL)
```

| Suite | What it proves |
|---|---|
| `unit/loan-state-machine` | Legal transitions only; terminal states are final; money parsing is strict and lossless |
| `integration/loan-service` | Status + audit commit together; illegal moves leave no trace; retries don't duplicate events; concurrent transitions serialise; audit rows can't be edited or deleted; ledger keys dedupe |
| `integration/disbursement-workflow` | Happy path; transient failures retried with exactly one payout; rejection releases the hold without retrying |
| `integration/api` | Unauthenticated, wrong-role, and auditor-write calls are refused; disburse is audited with the requesting user; bad amounts are rejected |

## Known limitations and next steps

These are deliberate scope cuts, listed because I think knowing where the edges
are matters as much as the code.

- **Ambiguous payout outcomes.** If the rail times out on every attempt, the
  money may or may not have moved. The workflow currently treats exhausted
  retries as a failure and releases the hold. A production version should
  query the rail by idempotency key before deciding, and route unresolved
  cases to manual review.
- **Audit on disburse request.** The request is audited before the workflow
  starts; a failed start leaves a "requested" event with no follow-up. A
  transactional outbox would make request and start atomic.
- **Authentication** is header-based for the demo. Production would verify an
  OIDC/JWT at the edge; only `auth.ts` changes.
- **Double-entry ledger.** Entries are single-sided (`hold`/`release`/`payout`).
  A real ledger would post balanced debits and credits across accounts.
- **Audit tamper-evidence.** Append-only stops edits through the database; hash-
  chaining each event to the previous one would also make tampering at the
  storage level detectable.
