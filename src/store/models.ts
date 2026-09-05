import { getConfigDb, tryGetConfigDb } from './config-db.js';

// The selectable model lineup, stored as one row. src/models.ts validates the
// shape and falls back to its built-in catalog when the row is missing.

export function getModelCatalog(): Record<string, unknown> | undefined {
  const db = tryGetConfigDb();
  if (!db) return undefined;
  const row = db
    .prepare('SELECT catalog FROM model_catalog WHERE id = 1')
    .get() as { catalog: string } | undefined;
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.catalog) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Malformed row — the caller uses its default catalog.
  }
  return undefined;
}

export function setModelCatalog(catalog: object): void {
  getConfigDb()
    .prepare(
      `INSERT INTO model_catalog (id, catalog, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         catalog = excluded.catalog,
         updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(catalog), new Date().toISOString());
}
