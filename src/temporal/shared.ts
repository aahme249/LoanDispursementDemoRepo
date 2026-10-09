import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASK_QUEUE = 'loan-disbursement';

/** One disbursement workflow per loan. Temporal rejects a second start with the same id. */
export const disbursementWorkflowId = (loanId: string) => `disburse-${loanId}`;

/**
 * Entry file for the worker's workflow bundler: workflows.ts when running from
 * source (tsx, vitest), workflows.js when running the compiled build.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKFLOWS_PATH = ['workflows.ts', 'workflows.js']
  .map((file) => path.join(here, file))
  .find((file) => existsSync(file)) ?? path.join(here, 'workflows.js');

export const WORKFLOW_ACTOR = 'system:disbursement-workflow' as const;
