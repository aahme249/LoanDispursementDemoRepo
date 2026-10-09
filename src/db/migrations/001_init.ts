import { type Kysely, sql } from 'kysely';

// Migrations take Kysely<any> on purpose: they describe the schema at a point in
// time and must not change when src/db/types.ts evolves.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('loans')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('borrower_id', 'text', (c) => c.notNull())
    .addColumn('amount_cents', 'bigint', (c) => c.notNull().check(sql`amount_cents > 0`))
    .addColumn('status', 'text', (c) =>
      c.notNull().check(sql`status in ('approved', 'disbursing', 'disbursed', 'failed')`),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('ledger_entries')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('loan_id', 'uuid', (c) => c.notNull().references('loans.id'))
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('hold', 'release', 'payout')`))
    .addColumn('amount_cents', 'bigint', (c) => c.notNull().check(sql`amount_cents > 0`))
    .addColumn('idempotency_key', 'text', (c) => c.notNull().unique())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('audit_events')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('loan_id', 'uuid', (c) => c.notNull().references('loans.id'))
    .addColumn('actor', 'text', (c) => c.notNull())
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('from_status', 'text')
    .addColumn('to_status', 'text')
    .addColumn('metadata', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    // clock_timestamp(), not now(): several events in one transaction still order correctly.
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`clock_timestamp()`))
    .execute();

  await db.schema.createIndex('audit_events_loan_idx').on('audit_events').columns(['loan_id', 'created_at']).execute();
  await db.schema.createIndex('ledger_entries_loan_idx').on('ledger_entries').column('loan_id').execute();

  // Append-only is enforced by the database, not by convention. A buggy code
  // path or a hand-run SQL session cannot rewrite history.
  await sql`
    create function reject_mutation() returns trigger language plpgsql as $$
    begin
      raise exception '% is append-only', tg_table_name;
    end;
    $$
  `.execute(db);
  for (const table of ['audit_events', 'ledger_entries']) {
    await sql`
      create trigger ${sql.raw(`${table}_append_only`)}
      before update or delete on ${sql.table(table)}
      for each row execute function reject_mutation()
    `.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('audit_events').execute();
  await db.schema.dropTable('ledger_entries').execute();
  await db.schema.dropTable('loans').execute();
  await sql`drop function reject_mutation()`.execute(db);
}
