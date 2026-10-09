import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

// Postgres int8 (OID 20) -> JS bigint. The pg default is string, which invites
// accidental Number() conversions and silent precision loss on large amounts.
pg.types.setTypeParser(20, (value) => BigInt(value));

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 10 }),
    }),
  });
}
