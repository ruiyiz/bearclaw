// One-shot migration: flat jid-keyed registered_agents.json → nested
// folder/channels shape (see src/agent-registry.ts). Idempotent: a registry
// already in the nested shape is left untouched. Backs up the old file first.
//
//   npx tsx src/scripts/migrate-registered-agents.ts
//
import fs from 'fs';
import path from 'path';

import { isNestedRegistry, migrateFlatToNested } from '../agent-registry.js';
import { CONFIG_DIR } from '../config.js';
import type { RegisteredAgent } from '../types.js';

function main(): void {
  const file = path.join(CONFIG_DIR, 'registered_agents.json');
  if (!fs.existsSync(file)) {
    console.log(`No registry at ${file} — nothing to migrate.`);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
  if (isNestedRegistry(raw)) {
    console.log('Registry already in nested format — nothing to do.');
    return;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Unexpected registry shape: expected a flat jid→agent map');
  }

  const nested = migrateFlatToNested(raw as Record<string, RegisteredAgent>);

  const backup = `${file}.flat.bak`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, `${JSON.stringify(nested, null, 2)}\n`);

  const folders = Object.keys(nested);
  console.log(
    `Migrated ${folders.length} agent folder(s): ${folders.join(', ')}`,
  );
  console.log(`Backup written to ${backup}`);
}

main();
