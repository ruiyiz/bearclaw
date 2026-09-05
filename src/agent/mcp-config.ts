import { logger } from '../logger.js';
import { listMcpServers } from '../store/mcp.js';

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
 * Build mcpServers from the enabled rows in the config database, with ${VAR}
 * env-var expansion across all string leaves. Missing env vars do not throw —
 * they expand to "" and are logged at WARN so the rest of the config still
 * loads. Returns {} when no server is configured.
 */
export function loadUserMcpServers(): Record<string, unknown> {
  const rows = listMcpServers().filter((row) => row.enabled);
  if (rows.length === 0) return {};

  const missing = new Set<string>();
  const servers: Record<string, unknown> = {};
  for (const row of rows) {
    servers[row.name] = expandEnv(row.config, missing);
  }
  if (missing.size > 0) {
    logger.warn(
      { missing: [...missing] },
      'mcp servers reference env vars that are not set; values expanded to empty string',
    );
  }
  return servers;
}
