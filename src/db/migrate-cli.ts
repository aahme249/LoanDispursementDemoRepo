import { createDb } from './client.js';
import { migrateToLatest } from './migrate.js';
import { requiredEnv } from '../env.js';

const db = createDb(requiredEnv('DATABASE_URL'));
try {
  await migrateToLatest(db);
  console.log('migrations applied');
} finally {
  await db.destroy();
}
