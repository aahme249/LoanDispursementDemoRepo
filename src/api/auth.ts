import { z } from 'zod';
import type { ActorId } from '../loans/service.js';

/**
 * Roles enforce separation of duties: whoever approves a loan cannot also
 * release the money.
 */
export const ROLES = ['underwriter', 'disbursement_ops', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  id: ActorId;
  role: Role;
}

const headerSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,64}$/i),
  role: z.enum(ROLES),
});

/**
 * DEMO ONLY: identity comes from plain headers. In production this would verify
 * a signed token (OIDC/JWT) at the edge and read the subject and role claims.
 * Everything downstream only sees `Actor`, so that swap is local to this file.
 */
export function actorFromHeaders(headers: Headers): Actor | null {
  const parsed = headerSchema.safeParse({
    id: headers.get('x-actor-id'),
    role: headers.get('x-actor-role'),
  });
  if (!parsed.success) return null;
  return { id: `user:${parsed.data.id}`, role: parsed.data.role };
}
