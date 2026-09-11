import fs from 'node:fs';
import path from 'node:path';

import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { PI_DIR } from '../config.js';

let runtime: Promise<ModelRuntime> | undefined;

export function piAuthPath(): string {
  return path.join(PI_DIR, 'auth.json');
}

export function piModelsPath(): string {
  return path.join(PI_DIR, 'models.json');
}

export function piModelsStorePath(): string {
  return path.join(PI_DIR, 'models-store.json');
}

/**
 * One process-wide Pi model runtime. Credentials are held in BearClaw's var
 * directory rather than Pi's global user directory.
 */
export function getPiModelRuntime(): Promise<ModelRuntime> {
  if (!runtime) {
    fs.mkdirSync(PI_DIR, { recursive: true, mode: 0o700 });
    runtime = ModelRuntime.create({
      authPath: piAuthPath(),
      modelsPath: piModelsPath(),
      modelsStorePath: piModelsStorePath(),
    });
  }
  return runtime;
}

export function resetPiModelRuntimeForTest(): void {
  runtime = undefined;
}
