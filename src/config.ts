import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

// Load .env before reading any env vars.
// This MUST happen here (not in index.ts) because ESM hoists imports,
// so config.ts is evaluated before index.ts body runs.
dotenv.config({ path: path.join(os.homedir(), '.nanoclaw', '.env') });

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY = process.env.TELEGRAM_ONLY === 'true';
export const IMESSAGE_ENABLED = process.env.IMESSAGE_ENABLED === 'true';
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const DISPLAY_NAME = process.env.DISPLAY_NAME || ASSISTANT_NAME;
export const POLL_INTERVAL = 30000; // Recovery sweep interval; normal dispatch is event-driven
export const SCHEDULER_POLL_INTERVAL = 60000;
export const EVENT_POLL_INTERVAL = 5000;

export const NANOCLAW_HOME = path.resolve(os.homedir(), '.nanoclaw');

export const STORE_DIR = path.resolve(NANOCLAW_HOME, 'store');
export const CONTEXT_DIR = path.resolve(NANOCLAW_HOME, 'context');
export const AGENTS_DIR = path.resolve(NANOCLAW_HOME, 'agents');
export const DATA_DIR = path.resolve(NANOCLAW_HOME, 'data');
export const MAIN_AGENT_FOLDER = 'main';

export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '300000',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const MEMORY_FLUSH_INTERVAL = 10 * 60 * 1000; // 10 minutes

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

export const STT_ECHO_ENABLED = process.env.STT_ECHO_ENABLED !== 'false';

export const EMAIL_DEFAULT_INTERVAL = '1h';
export const EMAIL_HANDLER_PREFIX = 'email-';

// Heartbeat — proactive agent initiative loop
export const HEARTBEAT_HANDLER_PREFIX = 'heartbeat-';

// Dream cycle — daily memory consolidation; bundles the daily session reset
export const DREAM_HANDLER_PREFIX = 'dream-';
export const DREAM_ENABLED = process.env.DREAM_ENABLED !== 'false';
export const DREAM_HOUR = parseInt(process.env.DREAM_HOUR ?? '4', 10);
export const DREAM_LOOKBACK_DAYS = parseInt(
  process.env.DREAM_LOOKBACK_DAYS ?? '7',
  10,
);
export const DREAM_MIN_NEW_ENTRIES = parseInt(
  process.env.DREAM_MIN_NEW_ENTRIES ?? '5',
  10,
);
export const DREAM_RECENCY_HALFLIFE = parseInt(
  process.env.DREAM_RECENCY_HALFLIFE ?? '3',
  10,
);
export const DREAM_MIN_SCORE = parseFloat(
  process.env.DREAM_MIN_SCORE ?? '0.55',
);
export const DREAM_MIN_SUPPORT = parseInt(
  process.env.DREAM_MIN_SUPPORT ?? '2',
  10,
);
export const DREAM_MIN_DIVERSITY = parseInt(
  process.env.DREAM_MIN_DIVERSITY ?? '2',
  10,
);
export const DREAM_ENGRAM_LINE_CAP = parseInt(
  process.env.DREAM_ENGRAM_LINE_CAP ?? '200',
  10,
);
export const DREAM_REPORT_CHANNEL = process.env.DREAM_REPORT_CHANNEL || '';

// Embeddings (vector retrieval)
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
export const EMBEDDING_DIMS = parseInt(
  process.env.EMBEDDING_DIMS ?? '1536',
  10,
);

// Google AI (Gemini) — image generation via gemini-2.5-flash-image (nano-banana)
export const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';

export const HEARTBEAT_PROMPT = `[HEARTBEAT — Proactive check-in. You are waking up on your own to look around.]

Read HEARTBEAT.md in your working directory. Follow its instructions exactly.
Do not infer tasks from previous conversations — only act on what HEARTBEAT.md says.

MEMORY: Read heartbeat-log.md in your working directory (create it if missing). This is your persistent memory across runs. It tracks what you have already suggested, asked about, or acted on. Use it to avoid repeating yourself:
- Before messaging the user, check if you already suggested or asked about the same thing recently.
- If nothing has changed since your last check-in on a topic, do not bring it up again.
- After each run, append a timestamped entry summarizing what you did or observed (keep the log concise — prune entries older than 7 days).

If nothing needs attention, reply with exactly: HEARTBEAT_OK
If something does need attention, take action (send messages, run commands, etc.) and describe what you did. Do NOT include HEARTBEAT_OK in your response if you took action.`;

// Timezone — uses TZ env var or system default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export function localDate(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

export function localTime(d = new Date()): string {
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TIMEZONE,
  });
}

export function localHour(d = new Date()): number {
  return parseInt(
    d.toLocaleString('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: TIMEZONE,
    }),
  );
}
