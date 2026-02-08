import os from 'os';
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const DISPLAY_NAME = process.env.DISPLAY_NAME || ASSISTANT_NAME;
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const EVENT_POLL_INTERVAL = 5000;

export const NANOCLAW_HOME = path.resolve(os.homedir(), '.nanoclaw');

export const STORE_DIR = path.resolve(NANOCLAW_HOME, 'store');
export const GROUPS_DIR = path.resolve(NANOCLAW_HOME, 'groups');
export const DATA_DIR = path.resolve(NANOCLAW_HOME, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '300000',
  10,
);
export const IPC_POLL_INTERVAL = 1000;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

export const EMAIL_POLL_INTERVAL = 3600000; // 1 hour
export const EMAIL_TRIGGER_ADDRESS = process.env.EMAIL_TRIGGER_ADDRESS || 'ruiyizhang+conan@gmail.com';
export const EMAIL_GROUP_FOLDER = 'email';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
