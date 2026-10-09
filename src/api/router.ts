import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { parseCents } from '../domain/money.js';
import type { AuditEvent, Loan } from '../db/types.js';
import { createApprovedLoan, getAuditTrail, getLoan, recordAuditEvent } from '../loans/service.js';
import { disburseLoan } from '../temporal/workflows.js';
import { TASK_QUEUE, disbursementWorkflowId } from '../temporal/shared.js';
import { allow, router } from './trpc.js';

const loanId = z.object({ loanId: z.uuid() });

// Wire format: explicit DTOs, money as strings. The DB row shape never leaks.
const toLoanDto = (loan: Loan) => ({
  id: loan.id,
  borrowerId: loan.borrower_id,
  amountCents: loan.amount_cents.toString(),
  status: loan.status,
  createdAt: loan.created_at.toISOString(),
  updatedAt: loan.updated_at.toISOString(),
});

const toAuditDto = (e: AuditEvent) => ({
  at: e.created_at.toISOString(),
  actor: e.actor,
  action: e.action,
  fromStatus: e.from_status,
  toStatus: e.to_status,
  metadata: e.metadata,
});

export const appRouter = router({
  loan: router({
    approve: allow('underwriter')
      .input(
        z.object({
          borrowerId: z.string().min(1).max(64),
          amountCents: z.string().transform((v, ctx) => {
            try {
              return parseCents(v);
            } catch (err) {
              ctx.addIssue({ code: 'custom', message: (err as Error).message });
              return z.NEVER;
            }
          }),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        toLoanDto(await createApprovedLoan(ctx.db, { ...input, actor: ctx.actor.id })),
      ),

    get: allow('underwriter', 'disbursement_ops', 'auditor')
      .input(loanId)
      .query(async ({ ctx, input }) => toLoanDto(await getLoan(ctx.db, input.loanId))),

    disburse: allow('disbursement_ops')
      .input(loanId)
      .mutation(async ({ ctx, input }) => {
        const loan = await getLoan(ctx.db, input.loanId);
        if (loan.status !== 'approved') {
          throw new TRPCError({ code: 'CONFLICT', message: `loan is ${loan.status}, not approved` });
        }

        // Audit who asked, before anything moves.
        await recordAuditEvent(ctx.db, { loanId: loan.id, actor: ctx.actor.id, action: 'disbursement.requested' });

        const workflowId = disbursementWorkflowId(loan.id);
        try {
          await ctx.temporal.workflow.start(disburseLoan, { taskQueue: TASK_QUEUE, workflowId, args: [loan.id] });
        } catch (err) {
          // A double-click or a retried request must not start a second payout.
          if (err instanceof WorkflowExecutionAlreadyStartedError) {
            throw new TRPCError({ code: 'CONFLICT', message: 'disbursement already in progress' });
          }
          throw err;
        }
        return { workflowId };
      }),

    auditTrail: allow('underwriter', 'disbursement_ops', 'auditor')
      .input(loanId)
      .query(async ({ ctx, input }) => {
        await getLoan(ctx.db, input.loanId); // 404 for unknown loans rather than an empty list
        return (await getAuditTrail(ctx.db, input.loanId)).map(toAuditDto);
      }),
  }),
});

export type AppRouter = typeof appRouter;
