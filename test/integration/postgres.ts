import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { createDb } from '../../src/db/client.js';
import { migrateToLatest } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/types.js';

/**
 * A real, freshly migrated Postgres for each test file. No database mocks.
 *
 * Default: a throwaway container via testcontainers.
 * If TEST_DATABASE_URL is set (e.g. a CI service or a local server), a new
 * uniquely named database is created on that server instead and dropped after.
 */
export async function startPostgres(): Promise<{ db: Kysely<Database>; stop: () => Promise<void> }> {
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (serverUrl) return useExistingServer(serverUrl);

  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const db = createDb(container.getConnectionUri());
  await migrateToLatest(db);
  return {
    db,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}

async function useExistingServer(serverUrl: string) {
  const name = `test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = createDb(serverUrl);
  await sql`create database ${sql.id(name)}`.execute(admin);

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  await migrateToLatest(db);
  return {
    db,
    stop: async () => {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    },
  };
}
