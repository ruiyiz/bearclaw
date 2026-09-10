import fs from 'node:fs';

import { initConfigDb } from './config-db.js';
import {
  AGENTS_VAR_DIR,
  AUTH_DIR,
  BEARCLAW_HOME,
  CACHE_DIR,
  LOG_DIR,
  PI_DIR,
  RUN_DIR,
  TMP_DIR,
  VAR_DIR,
} from './paths.js';
import { loadSettingsIntoEnv } from './settings.js';

// Deliberately imports nothing from src/config.ts: config.ts captures env vars
// at import time, so it must not be evaluated until settings have been loaded.
export function ensureVarLayout(): void {
  for (const dir of [
    BEARCLAW_HOME,
    VAR_DIR,
    CACHE_DIR,
    RUN_DIR,
    LOG_DIR,
    TMP_DIR,
    AUTH_DIR,
    PI_DIR,
    AGENTS_VAR_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function bootstrap(): void {
  ensureVarLayout();
  initConfigDb();
  loadSettingsIntoEnv();
}
