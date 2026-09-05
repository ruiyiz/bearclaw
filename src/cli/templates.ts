import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Starter documents shipped with the repo, not with the install. Setup copies
// them into the config database once; from there the owner edits them through
// the web UI or the agent, and this folder is never read again.

// src/cli/templates.ts and dist/cli/templates.js both sit two levels below the
// repo root, so the same climb works under tsx and after a build.
export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export const TEMPLATES_DIR = path.join(PROJECT_ROOT, 'templates');

export const CONTEXT_TEMPLATES = [
  'AGENTS.md',
  'CONTEXT.md',
  'SOUL.md',
  'USER.md',
] as const;

export const IDENTITY_TEMPLATE = 'agents/IDENTITY.md';

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

export function substitute(
  text: string,
  vars: Record<string, string> = {},
): string {
  return text.replace(PLACEHOLDER, (match, key: string) =>
    key in vars ? vars[key] : match,
  );
}

/** `name` is relative to templates/, e.g. 'context/USER.md'. */
export function loadTemplate(
  name: string,
  vars: Record<string, string> = {},
): string {
  const file = path.join(TEMPLATES_DIR, name);
  return substitute(fs.readFileSync(file, 'utf-8'), vars);
}

export function loadContextTemplate(
  name: string,
  vars: Record<string, string> = {},
): string {
  return loadTemplate(path.posix.join('context', name), vars);
}
