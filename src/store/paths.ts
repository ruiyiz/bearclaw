import os from 'node:os';
import path from 'node:path';

// Every path BearClaw owns hangs off BEARCLAW_HOME. This module reads one env
// var, derives the rest, and never throws — bootstrap imports it before
// anything else, so it must stay free of side effects.

export const BEARCLAW_HOME = path.resolve(
  process.env.BEARCLAW_HOME || path.join(os.homedir(), '.bearclaw'),
);

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
export const AGENTS_VAR_DIR = path.join(VAR_DIR, 'agents');

export const agentVarDir = (folder: string): string =>
  path.join(AGENTS_VAR_DIR, folder);
