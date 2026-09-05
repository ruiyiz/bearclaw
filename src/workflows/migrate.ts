import fs from 'node:fs';
import path from 'node:path';

import { TIMEZONE, VAR_DIR } from '../config.js';
import { getAllHandlers } from '../db.js';
import { logger } from '../logger.js';
import { loadRegistry, saveRegistry } from '../store/agents.js';
import { getContextFile } from '../store/context.js';
import { setSetting } from '../store/settings.js';
import type { Handler } from '../types.js';
import { intervalToCron } from '../utils/time.js';
import { saveJson } from '../utils/json.js';
import { ensureBuiltinWorkflows } from './builtins.js';
import { getWorkflowRow } from './db.js';
import { parseDefinition, type WorkflowDefinition } from './schema.js';
import { writeWorkflowFile } from './store.js';
import { createTrigger, nextCronRun } from './triggers.js';

const MARKER = () => path.join(VAR_DIR, 'workflows-migrated.json');
const HEARTBEAT_PREFIX = 'heartbeat-';

export function alreadyMigrated(): boolean {
  return fs.existsSync(MARKER());
}

export function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : `wf-${slug}`;
}

function isOneShot(handler: Handler): boolean {
  return handler.event_type === 'cron_trigger' && !handler.cron;
}

function handlerToDefinition(handler: Handler): WorkflowDefinition {
  const slug = slugify(handler.id);
  const trigger =
    handler.event_type === 'cron_trigger'
      ? {
          id: 'schedule',
          type: 'cron' as const,
          cron: handler.cron!,
          timezone: TIMEZONE,
          enabled: handler.status === 'active',
        }
      : {
          id: 'signal',
          type: 'event' as const,
          event: handler.event_type,
          filter: handler.filter
            ? (JSON.parse(handler.filter) as Record<string, unknown>)
            : undefined,
          enabled: handler.status === 'active',
        };

  return parseDefinition({
    $schema: 'bearclaw://workflow/v1',
    name: handler.id,
    slug,
    owner: handler.group_folder,
    description:
      'Migrated from a handler row. Refactor into typed nodes when ready.',
    triggers: [trigger],
    policies: { concurrency: 'skip' },
    nodes: {
      run: {
        type: 'agent',
        prompt: handler.prompt,
        // context_mode 'agent' shared the folder's chat session.
        session: handler.context_mode === 'agent' ? 'chat' : 'fresh',
      },
    },
    edges: [],
  });
}

function heartbeatBrief(folder: string): string {
  return getContextFile('agent', folder, 'HEARTBEAT.md')?.trim() ?? '';
}

function checkinDefinition(
  folder: string,
  heartbeat: {
    interval: string;
    model?: string;
    quiet?: { start: string; end: string };
  },
  enabled: boolean,
): WorkflowDefinition {
  const brief = heartbeatBrief(folder);
  const prompt = [
    'Proactive check-in. You are waking up on your own to look around.',
    'Follow the brief exactly. Do not infer tasks from previous conversations.',
    'If nothing needs attention, say so in one line and stop.',
    '',
    brief || '(no brief configured)',
  ].join('\n');

  return parseDefinition({
    $schema: 'bearclaw://workflow/v1',
    name: `${folder} check-in`,
    slug: `${slugify(folder)}-checkin`,
    owner: folder,
    description: 'Migrated from the heartbeat config.',
    triggers: [
      {
        id: 'schedule',
        type: 'cron',
        cron: intervalToCron(heartbeat.interval),
        timezone: TIMEZONE,
        quiet: heartbeat.quiet,
        enabled,
      },
    ],
    policies: { concurrency: 'skip' },
    nodes: {
      checkin: {
        type: 'agent',
        prompt,
        model: heartbeat.model,
        session: 'chat',
      },
    },
    edges: [],
  });
}

export interface MigrationReport {
  workflows: string[];
  reminders: number;
  heartbeats: string[];
  skipped: string[];
}

// One-time cut-over from handlers rows and heartbeat registry blocks to
// workflow files. Handler logs are left in place until their retention window
// passes.
export function migrateHandlersToWorkflows(force = false): MigrationReport {
  const report: MigrationReport = {
    workflows: [],
    reminders: 0,
    heartbeats: [],
    skipped: [],
  };
  if (alreadyMigrated() && !force) return report;

  ensureBuiltinWorkflows();

  for (const handler of getAllHandlers()) {
    if (handler.id.startsWith(HEARTBEAT_PREFIX)) {
      report.skipped.push(handler.id);
      continue;
    }

    if (isOneShot(handler)) {
      // A pending one-shot becomes an `at` trigger on the shared reminder
      // workflow; a spent one is dropped.
      if (handler.status !== 'active' || !handler.next_run) {
        report.skipped.push(handler.id);
        continue;
      }
      try {
        createTrigger({
          slug: 'reminder',
          type: 'at',
          config: { at: handler.next_run },
          args: { text: handler.prompt },
          createdBy: handler.group_folder,
        });
        report.reminders += 1;
      } catch (err) {
        logger.warn(
          { err, handler: handler.id },
          'workflow migration: reminder skipped',
        );
        report.skipped.push(handler.id);
      }
      continue;
    }

    try {
      const def = handlerToDefinition(handler);
      if (getWorkflowRow(def.slug)) {
        report.skipped.push(handler.id);
        continue;
      }
      writeWorkflowFile(def);
      report.workflows.push(def.slug);
    } catch (err) {
      logger.warn(
        { err, handler: handler.id },
        'workflow migration: handler skipped',
      );
      report.skipped.push(handler.id);
    }
  }

  const registry = loadRegistry();
  const registryBefore = JSON.stringify(registry);
  let registryChanged = false;
  const handlerStatus = new Map(getAllHandlers().map((h) => [h.id, h.status]));

  for (const [folder, agent] of Object.entries(registry)) {
    const heartbeat = agent.heartbeat;
    if (!heartbeat) continue;
    const enabled =
      handlerStatus.get(`${HEARTBEAT_PREFIX}${folder}`) !== 'paused';
    try {
      const def = checkinDefinition(folder, heartbeat, enabled);
      if (!getWorkflowRow(def.slug)) {
        writeWorkflowFile(def);
        report.heartbeats.push(def.slug);
      }
      delete registry[folder].heartbeat;
      registryChanged = true;
    } catch (err) {
      logger.warn({ err, folder }, 'workflow migration: heartbeat skipped');
    }
  }
  if (registryChanged) {
    // Keep the pre-migration registry before dropping the heartbeat blocks
    // out of it.
    try {
      setSetting('bearclaw.registry_pre_workflows', registryBefore, {
        secret: false,
      });
    } catch (err) {
      logger.warn({ err }, 'workflow migration: registry backup failed');
    }
    saveRegistry(registry);
  }

  saveJson(MARKER(), { migrated_at: new Date().toISOString(), ...report });
  logger.info(report, 'workflow migration complete');
  return report;
}

export { nextCronRun };
