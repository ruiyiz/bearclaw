import { getConfigDb, tryGetConfigDb } from './config-db.js';

// Raw definition rows. Validation belongs to src/workflows/store.ts, which
// parses the JSON text and keeps the messages.db index in step.

export interface WorkflowDefinitionRow {
  slug: string;
  /** The definition as stored: JSON text. */
  definition: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRow(raw: {
  slug: string;
  definition: string;
  updated_at: string;
}): WorkflowDefinitionRow {
  return {
    slug: raw.slug,
    definition: raw.definition,
    updatedAt: raw.updated_at,
  };
}

export function listWorkflowDefinitions(): WorkflowDefinitionRow[] {
  const db = tryGetConfigDb();
  if (!db) return [];
  return (
    db
      .prepare(
        'SELECT slug, definition, updated_at FROM workflow_definitions ORDER BY slug',
      )
      .all() as { slug: string; definition: string; updated_at: string }[]
  ).map(toRow);
}

export function getWorkflowDefinition(
  slug: string,
): WorkflowDefinitionRow | undefined {
  const db = tryGetConfigDb();
  if (!db) return undefined;
  const row = db
    .prepare(
      'SELECT slug, definition, updated_at FROM workflow_definitions WHERE slug = ?',
    )
    .get(slug) as
    | { slug: string; definition: string; updated_at: string }
    | undefined;
  return row ? toRow(row) : undefined;
}

export function putWorkflowDefinition(
  slug: string,
  definition: string | object,
): WorkflowDefinitionRow {
  const text =
    typeof definition === 'string'
      ? definition
      : JSON.stringify(definition, null, 2);
  const updatedAt = nowIso();
  getConfigDb()
    .prepare(
      `INSERT INTO workflow_definitions (slug, definition, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         definition = excluded.definition,
         updated_at = excluded.updated_at`,
    )
    .run(slug, text, updatedAt);
  return { slug, definition: text, updatedAt };
}

export function deleteWorkflowDefinition(slug: string): boolean {
  const db = tryGetConfigDb();
  if (!db) return false;
  return (
    db.prepare('DELETE FROM workflow_definitions WHERE slug = ?').run(slug)
      .changes > 0
  );
}
