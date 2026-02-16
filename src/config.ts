import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

// Load .env before reading any env vars.
// This MUST happen here (not in index.ts) because ESM hoists imports,
// so config.ts is evaluated before index.ts body runs.
dotenv.config({ path: path.join(os.homedir(), '.nanoclaw', '.env') });

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY = process.env.TELEGRAM_ONLY === 'true';
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

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

// Session reset — clear stale sessions to prevent unbounded context growth
// Set to -1 to disable
export const SESSION_RESET_HOUR = parseInt(
  process.env.SESSION_RESET_HOUR ?? '4',
  10,
);
export const SESSION_IDLE_MINUTES = parseInt(
  process.env.SESSION_IDLE_MINUTES ?? '-1',
  10,
);

export const EMAIL_DEFAULT_INTERVAL = '1h';
export const EMAIL_HANDLER_PREFIX = 'email-';

// Odyssey — proactive agent initiative loop
export const ODYSSEY_HANDLER_PREFIX = 'odyssey-';

export const ODYSSEY_PROMPT = `[ODYSSEY — Proactive check-in. You are waking up on your own to look around.]

Read ODYSSEY.md in your working directory. Follow its instructions exactly.
Do not infer tasks from previous conversations — only act on what ODYSSEY.md says.

MEMORY: Read odyssey-log.md in your working directory (create it if missing). This is your persistent memory across runs. It tracks what you have already suggested, asked about, or acted on. Use it to avoid repeating yourself:
- Before messaging the user, check if you already suggested or asked about the same thing recently.
- If nothing has changed since your last check-in on a topic, do not bring it up again.
- After each run, append a timestamped entry summarizing what you did or observed (keep the log concise — prune entries older than 7 days).

If nothing needs attention, reply with exactly: ODYSSEY_OK
If something does need attention, take action (send messages, run commands, etc.) and describe what you did. Do NOT include ODYSSEY_OK in your response if you took action.`;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
