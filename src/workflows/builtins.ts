import fs from 'node:fs';

import { logger } from '../logger.js';
import { getWorkflowRow } from './db.js';
import type { WorkflowDefinition } from './schema.js';
import { workflowFilePath, writeWorkflowFile } from './store.js';

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

// Seeded once. The file is then the owner's to edit like any other.
export function ensureBuiltinWorkflows(): void {
  for (const def of BUILTINS) {
    if (fs.existsSync(workflowFilePath(def.slug)) || getWorkflowRow(def.slug))
      continue;
    writeWorkflowFile(def);
    logger.info({ slug: def.slug }, 'workflow: builtin seeded');
  }
}
