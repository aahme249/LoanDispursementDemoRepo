import type { Kysely } from 'kysely';
import { type Migration, Migrator } from 'kysely/migration';
import * as m001 from './migrations/001_init.js';

// Migrations are imported statically rather than read from disk, so the set is
// type-checked, bundled with the build, and identical in tests and production.
const migrations: Record<string, Migration> = {
  '001_init': m001,
};

export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration failed: ${r.migrationName}`);
  }
  if (error) throw error;
}
