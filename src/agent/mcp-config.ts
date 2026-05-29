import fs from 'fs';
import path from 'path';

import { CONFIG_DIR } from '../config.js';
import { logger } from '../logger.js';

const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function expandEnv(value: unknown, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_PATTERN, (_, name: string) => {
      const v = process.env[name];
      if (v === undefined) {
        missing.add(name);
        return '';
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnv(v, missing));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        expandEnv(v, missing),
      ]),
    );
  }
  return value;
}

/**
 * Load mcpServers from ~/.bearclaw/config/mcp.json with ${VAR} env-var
 * expansion across all string leaves. Missing env vars do not throw —
 * they expand to "" and are logged at WARN so the rest of the config
 * still loads. Returns {} on missing/invalid file.
 */
export function loadUserMcpServers(): Record<string, unknown> {
  const mcpConfigPath = path.join(CONFIG_DIR, 'mcp.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
  } catch {
    return {};
  }
  const servers =
    raw && typeof raw === 'object' && 'mcpServers' in raw
      ? (raw as { mcpServers?: unknown }).mcpServers
      : undefined;
  if (!servers || typeof servers !== 'object') return {};

  const missing = new Set<string>();
  const expanded = expandEnv(servers, missing) as Record<string, unknown>;
  if (missing.size > 0) {
    logger.warn(
      { missing: [...missing], path: mcpConfigPath },
      'mcp.json references env vars that are not set; values expanded to empty string',
    );
  }
  return expanded;
}
