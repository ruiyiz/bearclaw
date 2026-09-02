import fs from 'fs';
import path from 'path';

export function loadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Return default on error
  }
  return defaultValue;
}

export function saveJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// SQLite is dynamically typed, so a value bound as a Buffer stays a BLOB even
// in a TEXT column (e.g. a prompt inserted with the sqlite3 CLI's readfile()).
// better-sqlite3 hands those back as Buffers, which serialize to
// `{type, data}` and break every JSON consumer downstream. Decode on read.
export function decodeBlobs<T>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    const v = r[key];
    if (Buffer.isBuffer(v)) r[key] = v.toString('utf8');
  }
  return row;
}
