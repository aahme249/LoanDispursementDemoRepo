import { initTRPC, TRPCError } from '@trpc/server';
import type { Client } from '@temporalio/client';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { InvalidTransitionError } from '../domain/loan.js';
import { LoanNotFoundError } from '../loans/service.js';
import type { Actor, Role } from './auth.js';

export interface Context {
  db: Kysely<Database>;
  temporal: Pick<Client, 'workflow'>;
  actor: Actor | null;
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    // Never leak internals (SQL, stack traces) to callers.
    if (error.code === 'INTERNAL_SERVER_ERROR') return { ...shape, message: 'internal error' };
    return shape;
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Map domain errors to transport errors in one place. */
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof LoanNotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: cause.message });
    if (cause instanceof InvalidTransitionError) throw new TRPCError({ code: 'CONFLICT', message: cause.message });
  }
  return result;
});

const authenticated = t.procedure.use(domainErrors).use(({ ctx, next }) => {
  if (!ctx.actor) throw new TRPCError({ code: 'UNAUTHORIZED' });
  // Narrow `actor` to non-null for every procedure built on this.
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

/** Deny by default: each procedure names exactly the roles allowed to call it. */
export function allow(...roles: [Role, ...Role[]]) {
  return authenticated.use(({ ctx, next }) => {
    if (!roles.includes(ctx.actor.role)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: `role ${ctx.actor.role} may not do this` });
    }
    return next();
  });
}
