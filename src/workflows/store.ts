import { advise, formatIssue } from './checks.js';
import { logger } from '../logger.js';
import { tierForModel } from '../model-tiers.js';
import {
  deleteWorkflowDefinition,
  listWorkflowDefinitions,
  putWorkflowDefinition,
} from '../store/workflows.js';
import {
  deleteTriggersForSlug,
  deleteWorkflowRow,
  getWorkflowRow,
  listTriggerRows,
  listWorkflowRows,
  upsertWorkflowIndex,
} from './db.js';
import {
  WorkflowValidationError,
  parseDefinition,
  type WorkflowDefinition,
} from './schema.js';
import { syncFileTriggers } from './triggers.js';

export interface LoadReport {
  loaded: string[];
  removed: string[];
  /** Slugs whose leftover trigger rows were swept; see the sweep below. */
  orphanTriggers: string[];
  /** Advisory issues per slug: saved, but worth someone's attention. */
  warnings: { slug: string; issues: string[] }[];
  errors: { slug: string; issues: string[] }[];
}

/** Replace provider-specific legacy node.model values with portable tiers. */
function migrateWorkflowModelTiers(raw: Record<string, unknown>): boolean {
  const nodes = raw.nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return false;
  let changed = false;
  for (const node of Object.values(nodes as Record<string, unknown>)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const item = node as Record<string, unknown>;
    if (item.type !== 'agent' || typeof item.model !== 'string') continue;
    const tier = tierForModel(item.model);
    if (!tier) continue;
    item.model_tier = tier;
    delete item.model;
    changed = true;
  }
  return changed;
}

// The config database is the source of truth: `workflow_definitions` holds the
// definitions, the `workflows` table in messages.db is a runtime index.
export function syncWorkflowDefinitions(): LoadReport {
  const report: LoadReport = {
    loaded: [],
    removed: [],
    orphanTriggers: [],
    warnings: [],
    errors: [],
  };
  const seen = new Set<string>();

  for (const row of listWorkflowDefinitions()) {
    try {
      const raw = JSON.parse(row.definition) as Record<string, unknown>;
      const migrated = migrateWorkflowModelTiers(raw);
      const def = parseDefinition(raw);
      if (def.slug !== row.slug) {
        report.errors.push({
          slug: row.slug,
          issues: [`slug "${def.slug}" does not match the row key`],
        });
        continue;
      }
      upsertWorkflowIndex({
        slug: def.slug,
        name: def.name,
        owner: def.owner,
        definition: def,
      });
      syncFileTriggers(def);
      if (migrated) putWorkflowDefinition(def.slug, def);
      seen.add(def.slug);
      report.loaded.push(def.slug);
      const notes = advise(def);
      if (notes.length)
        report.warnings.push({
          slug: def.slug,
          issues: notes.map(formatIssue),
        });
    } catch (err) {
      const issues =
        err instanceof WorkflowValidationError
          ? err.issues
          : [err instanceof Error ? err.message : String(err)];
      report.errors.push({ slug: row.slug, issues });
    }
  }

  for (const row of listWorkflowRows()) {
    if (seen.has(row.slug)) continue;
    deleteTriggersForSlug(row.slug);
    deleteWorkflowRow(row.slug);
    report.removed.push(row.slug);
  }

  // A trigger whose workflow row went first is unreachable. Sweep by slug so
  // the pair can never drift apart.
  const orphans = new Set(
    listTriggerRows()
      .map((t) => t.slug)
      .filter((slug) => !seen.has(slug)),
  );
  for (const slug of orphans) {
    const removed = deleteTriggersForSlug(slug);
    if (removed) report.orphanTriggers.push(slug);
  }

  if (report.errors.length)
    logger.warn({ errors: report.errors }, 'workflow: invalid definitions');
  if (report.warnings.length)
    logger.warn(
      { warnings: report.warnings },
      'workflow: definitions worth a look',
    );
  if (report.orphanTriggers.length)
    logger.warn(
      { slugs: report.orphanTriggers },
      'workflow: swept triggers with no workflow',
    );
  logger.info(
    { loaded: report.loaded.length, removed: report.removed.length },
    'workflow: definitions synced',
  );
  return report;
}

export function saveWorkflowDefinition(
  def: WorkflowDefinition,
): WorkflowDefinition {
  const raw = structuredClone(def) as Record<string, unknown>;
  migrateWorkflowModelTiers(raw);
  const validated = parseDefinition(raw);
  putWorkflowDefinition(validated.slug, validated);
  upsertWorkflowIndex({
    slug: validated.slug,
    name: validated.name,
    owner: validated.owner,
    definition: validated,
  });
  syncFileTriggers(validated);
  return validated;
}

export function deleteWorkflow(slug: string): boolean {
  const hadRow = Boolean(getWorkflowRow(slug));
  const hadDefinition = deleteWorkflowDefinition(slug);
  if (!hadRow && !hadDefinition) return false;
  deleteTriggersForSlug(slug);
  deleteWorkflowRow(slug);
  return true;
}

export function getDefinition(slug: string): WorkflowDefinition | undefined {
  return getWorkflowRow(slug)?.definition;
}
