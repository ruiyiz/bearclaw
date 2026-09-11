import os from 'node:os';
import path from 'node:path';

// Every path BearClaw owns hangs off BEARCLAW_HOME. This module reads one env
// var, derives the rest, and never throws — bootstrap imports it before
// anything else, so it must stay free of side effects.

function resolveHome(): string {
  return path.resolve(
    process.env.BEARCLAW_HOME || path.join(os.homedir(), '.bearclaw'),
  );
}

export const BEARCLAW_HOME = resolveHome();

export const CONFIG_DB_PATH = path.join(BEARCLAW_HOME, 'bearclaw.db');

export const VAR_DIR = path.join(BEARCLAW_HOME, 'var');
export const CACHE_DIR = path.join(VAR_DIR, 'cache');
export const SKILLS_CACHE_DIR = path.join(CACHE_DIR, 'skills');
export const CONTEXT_CACHE_DIR = path.join(CACHE_DIR, 'context');
export const DATA_DIR = VAR_DIR;
export const RUN_DIR = path.join(VAR_DIR, 'run');
export const LOG_DIR = path.join(VAR_DIR, 'log');
export const TMP_DIR = path.join(VAR_DIR, 'tmp');
export const AUTH_DIR = path.join(VAR_DIR, 'auth');
// Pi's OAuth credentials and model cache are BearClaw-owned runtime state,
// never global ~/.pi state. This keeps exports and permissions scoped to one
// BearClaw installation.
export const PI_DIR = path.join(VAR_DIR, 'pi');
export const AGENTS_VAR_DIR = path.join(VAR_DIR, 'agents');

export const MAIN_AGENT_FOLDER = 'main';

// Late-bound variants. BEARCLAW_HOME is fixed for the life of a real process,
// but tests re-point it after these modules are already imported, so anything
// that touches the mirrors resolves its paths per call instead of at import.
export const varDir = (): string => path.join(resolveHome(), 'var');
export const cacheDir = (): string => path.join(varDir(), 'cache');
export const contextCacheDir = (): string => path.join(cacheDir(), 'context');
export const skillsCacheDir = (): string => path.join(cacheDir(), 'skills');
export const agentsVarDir = (): string => path.join(varDir(), 'agents');
export const piDir = (): string => path.join(varDir(), 'pi');

export const agentVarDir = (folder: string): string =>
  path.join(agentsVarDir(), folder);
