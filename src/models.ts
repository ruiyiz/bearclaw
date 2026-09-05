import { getModelCatalog } from './store/models.js';

// Model catalog — the single source of truth for selectable models, their
// aliases, and context-window sizes. Ships with a built-in lineup and can be
// overridden by the model_catalog row in the config database (same shape as
// DEFAULT_CATALOG below). A missing or malformed row falls back to the
// default. Read at import time, so a process that has not opened the config
// database yet gets the built-in lineup.

export interface ModelSpec {
  alias: string; // canonical alias, e.g. 'opus'
  short?: string; // short alias, e.g. 'o'
  id: string; // model id sent to the SDK — a family alias ('opus') resolves
  // to the newest version of that class; a full id pins one version
  label: string; // human-readable name
  contextWindow: number; // max input tokens
}

interface ModelCatalog {
  models: ModelSpec[];
  // Prefixes of model ids with a 1M-token context window. Used to resolve the
  // context window of a model an agent is pinned to but that isn't in the
  // selectable list above (legacy or preview ids). Anything not matched here
  // and not in `models` defaults to 200K.
  largeContextPrefixes: string[];
}

const DEFAULT_CATALOG: ModelCatalog = {
  models: [
    {
      alias: 'fable',
      short: 'f',
      id: 'fable',
      label: 'Claude Fable',
      contextWindow: 1_000_000,
    },
    {
      alias: 'opus',
      short: 'o',
      id: 'opus',
      label: 'Claude Opus',
      contextWindow: 1_000_000,
    },
    {
      alias: 'sonnet',
      short: 's',
      id: 'sonnet',
      label: 'Claude Sonnet',
      contextWindow: 1_000_000,
    },
    {
      alias: 'haiku',
      short: 'h',
      id: 'haiku',
      label: 'Claude Haiku',
      contextWindow: 200_000,
    },
  ],
  largeContextPrefixes: [
    'claude-fable',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-mythos',
  ],
};

function loadCatalog(): ModelCatalog {
  const parsed = getModelCatalog() as Partial<ModelCatalog> | undefined;
  if (parsed && Array.isArray(parsed.models) && parsed.models.length > 0) {
    return {
      models: parsed.models,
      largeContextPrefixes:
        parsed.largeContextPrefixes ?? DEFAULT_CATALOG.largeContextPrefixes,
    };
  }
  return DEFAULT_CATALOG;
}

const CATALOG = loadCatalog();

export const MODELS: ModelSpec[] = CATALOG.models;

const ALIAS_TO_ID = new Map<string, string>();
for (const m of MODELS) {
  ALIAS_TO_ID.set(m.alias.toLowerCase(), m.id);
  if (m.short) ALIAS_TO_ID.set(m.short.toLowerCase(), m.id);
}

// Resolve a user-supplied alias (canonical or short) to a full model id.
export function resolveModelAlias(arg: string): string | undefined {
  return ALIAS_TO_ID.get(arg.trim().toLowerCase());
}

// Map a full model id back to its friendly alias for display.
export function aliasForId(id: string): string {
  const exact = MODELS.find((m) => id.startsWith(m.id));
  if (exact) return exact.alias;
  const family = MODELS.find((m) => id.includes(m.alias));
  return family ? family.alias : id;
}

// Context window (max input tokens) for a model id. Family aliases match
// their catalog entry; pinned full ids fall back to the prefix list.
export function contextWindowForModel(id: string): number {
  const spec = MODELS.find((m) => id.startsWith(m.id));
  if (spec) return spec.contextWindow;
  return CATALOG.largeContextPrefixes.some((p) => id.startsWith(p))
    ? 1_000_000
    : 200_000;
}

// Comma-separated backtick-quoted alias list for help text.
export function modelAliasList(): string {
  return MODELS.map((m) => `\`${m.alias}\``).join(', ');
}
