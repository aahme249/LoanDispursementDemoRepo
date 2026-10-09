import { NativeConnection, Worker } from '@temporalio/worker';
import { createDb } from '../db/client.js';
import { requiredEnv } from '../env.js';
import { FakeRail } from '../payments/rail.js';
import { createActivities } from './activities.js';
import { TASK_QUEUE, WORKFLOWS_PATH } from './shared.js';

async function main() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const db = createDb(requiredEnv('DATABASE_URL'));

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    // Swap FakeRail for a real adapter here; nothing else changes.
    activities: createActivities({ db, rail: new FakeRail() }),
  });

  try {
    await worker.run();
  } finally {
    await db.destroy();
    await connection.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
