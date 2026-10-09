import { serve } from '@hono/node-server';
import { trpcServer } from '@hono/trpc-server';
import { Client, Connection } from '@temporalio/client';
import { Hono } from 'hono';
import { createDb } from '../db/client.js';
import { requiredEnv } from '../env.js';
import { actorFromHeaders } from './auth.js';
import { appRouter } from './router.js';

async function main() {
  const db = createDb(requiredEnv('DATABASE_URL'));
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const temporal = new Client({ connection });

  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.use(
    '/trpc/*',
    trpcServer({
      router: appRouter,
      createContext: ({ req }) => ({ db, temporal, actor: actorFromHeaders(req.headers) }),
    }),
  );

  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  console.log(`api listening on http://localhost:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
