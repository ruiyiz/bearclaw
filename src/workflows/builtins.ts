import { logger } from '../logger.js';
import { getWorkflowDefinition } from '../store/workflows.js';
import { getWorkflowRow } from './db.js';
import type { WorkflowDefinition } from './schema.js';
import { saveWorkflowDefinition } from './store.js';

// One reminder workflow serves every "remind me tomorrow at 9": the agent adds
// an `at` trigger with args instead of writing a workflow per reminder.
export const REMINDER: WorkflowDefinition = {
  $schema: 'bearclaw://workflow/v1',
  name: 'Reminder',
  slug: 'reminder',
  owner: 'main',
  description: 'Delivers a one-off reminder to a chat target.',
  tags: ['reminders'],
  inputs: {
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string' },
      to: { type: 'string' },
    },
  },
  triggers: [],
  policies: { concurrency: 'allow' },
  nodes: {
    deliver: {
      type: 'send',
      text: '{{inputs.text}}',
      to: "{{default inputs.to 'primary'}}",
    },
  },
  edges: [],
} as WorkflowDefinition;

const BUILTINS: WorkflowDefinition[] = [REMINDER];

// Seeded once. The definition row is then the owner's to edit like any other.
export function ensureBuiltinWorkflows(): void {
  for (const def of BUILTINS) {
    if (getWorkflowDefinition(def.slug) || getWorkflowRow(def.slug)) continue;
    saveWorkflowDefinition(def);
    logger.info({ slug: def.slug }, 'workflow: builtin seeded');
  }
}
