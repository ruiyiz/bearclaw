import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeConfigDb, initConfigDb } from './config-db.js';

export interface TempHome {
  home: string;
  dbPath: string;
  dispose(): void;
}

// A throwaway ~/.bearclaw for tests. BEARCLAW_HOME is exported before the
// config db opens, so any module imported *after* this call sees the temp home;
// modules that captured paths earlier keep the real ones.
export function withTempHome(prefix = 'bearclaw-home-'): TempHome {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = process.env.BEARCLAW_HOME;
  process.env.BEARCLAW_HOME = home;
  fs.mkdirSync(path.join(home, 'var'), { recursive: true });
  const dbPath = path.join(home, 'bearclaw.db');
  initConfigDb(dbPath);
  return {
    home,
    dbPath,
    dispose() {
      closeConfigDb();
      if (previous === undefined) delete process.env.BEARCLAW_HOME;
      else process.env.BEARCLAW_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
