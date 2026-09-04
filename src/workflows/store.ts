import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { WORKFLOWS_DIR } from '../config.js';
import { advise, formatIssue } from './checks.js';
import { logger } from '../logger.js';
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

export function workflowFilePath(slug: string): string {
  return path.join(WORKFLOWS_DIR, `${slug}.json`);
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export interface LoadReport {
  loaded: string[];
  removed: string[];
  /** Slugs whose leftover trigger rows were swept; see the sweep below. */
  orphanTriggers: string[];
  /** Advisory issues per slug: saved, but worth someone's attention. */
  warnings: { slug: string; issues: string[] }[];
  errors: { file: string; issues: string[] }[];
}

// Files are the source of truth: the owner and the agent edit them with
// ordinary file tools, they diff in git, and the index table is a cache.
export function syncWorkflowFiles(): LoadReport {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const report: LoadReport = {
    loaded: [],
    removed: [],
    orphanTriggers: [],
    warnings: [],
    errors: [],
  };
  const seen = new Set<string>();

  for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(WORKFLOWS_DIR, file);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      report.errors.push({ file, issues: [String(err)] });
      continue;
    }
    try {
      const def = parseDefinition(JSON.parse(raw));
      const expected = `${def.slug}.json`;
      if (file !== expected) {
        report.errors.push({
          file,
          issues: [`slug "${def.slug}" does not match filename`],
        });
        continue;
      }
      upsertWorkflowIndex({
        slug: def.slug,
        name: def.name,
        owner: def.owner,
        file_path: filePath,
        file_hash: hashOf(raw),
        definition: def,
      });
      syncFileTriggers(def);
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
      report.errors.push({ file, issues });
    }
  }

  for (const row of listWorkflowRows()) {
    if (!row.file_path || seen.has(row.slug)) continue;
    deleteTriggersForSlug(row.slug);
    deleteWorkflowRow(row.slug);
    report.removed.push(row.slug);
  }

  // A trigger whose workflow row went first is unreachable: the API refuses to
  // delete a file-sourced row ("edit the file instead") and there is no file
  // left to edit. Sweep by slug so the pair can never drift apart.
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

export function writeWorkflowFile(def: WorkflowDefinition): WorkflowDefinition {
  const validated = parseDefinition(def);
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const filePath = workflowFilePath(validated.slug);
  const text = `${JSON.stringify(validated, null, 2)}\n`;
  fs.writeFileSync(`${filePath}.tmp`, text);
  fs.renameSync(`${filePath}.tmp`, filePath);
  upsertWorkflowIndex({
    slug: validated.slug,
    name: validated.name,
    owner: validated.owner,
    file_path: filePath,
    file_hash: hashOf(text),
    definition: validated,
  });
  syncFileTriggers(validated);
  return validated;
}

export function deleteWorkflow(slug: string): boolean {
  const row = getWorkflowRow(slug);
  if (!row) return false;
  if (row.file_path && fs.existsSync(row.file_path))
    fs.unlinkSync(row.file_path);
  deleteTriggersForSlug(slug);
  deleteWorkflowRow(slug);
  return true;
}

export function getDefinition(slug: string): WorkflowDefinition | undefined {
  return getWorkflowRow(slug)?.definition;
}

// Debounced so an editor writing a file in several chunks reloads once.
export function watchWorkflowFiles(
  onChange?: (r: LoadReport) => void,
): () => void {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(WORKFLOWS_DIR, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        // Not `onChange?.(syncWorkflowFiles())`: optional call short-circuits
        // its own arguments, so the reload would never run without a callback.
        const report = syncWorkflowFiles();
        onChange?.(report);
      } catch (err) {
        logger.error({ err }, 'workflow: reload failed');
      }
    }, 200);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
