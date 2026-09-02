import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { WORKFLOWS_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  deleteWorkflowRow,
  getWorkflowRow,
  listWorkflowRows,
  upsertWorkflowIndex,
} from './db.js';
import {
  WorkflowValidationError,
  parseDefinition,
  type WorkflowDefinition,
} from './schema.js';

export function workflowFilePath(slug: string): string {
  return path.join(WORKFLOWS_DIR, `${slug}.json`);
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export interface LoadReport {
  loaded: string[];
  removed: string[];
  errors: { file: string; issues: string[] }[];
}

// Files are the source of truth: the owner and the agent edit them with
// ordinary file tools, they diff in git, and the index table is a cache.
export function syncWorkflowFiles(): LoadReport {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const report: LoadReport = { loaded: [], removed: [], errors: [] };
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
      seen.add(def.slug);
      report.loaded.push(def.slug);
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
    deleteWorkflowRow(row.slug);
    report.removed.push(row.slug);
  }

  if (report.errors.length)
    logger.warn({ errors: report.errors }, 'workflow: invalid definitions');
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
  return validated;
}

export function deleteWorkflow(slug: string): boolean {
  const row = getWorkflowRow(slug);
  if (!row) return false;
  if (row.file_path && fs.existsSync(row.file_path))
    fs.unlinkSync(row.file_path);
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
        onChange?.(syncWorkflowFiles());
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
