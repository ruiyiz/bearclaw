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

// Persistent (tracked)
export const CONFIG_DIR = path.resolve(NANOCLAW_HOME, 'config');
export const CONTEXT_DIR = path.resolve(NANOCLAW_HOME, 'context');
export const AGENTS_DIR = path.resolve(NANOCLAW_HOME, 'agents');
export const SKILLS_DIR = path.resolve(NANOCLAW_HOME, 'skills');

// Runtime (gitignored)
export const VAR_DIR = path.resolve(NANOCLAW_HOME, 'var');
export const CACHE_DIR = path.resolve(VAR_DIR, 'cache');
export const DATA_DIR = VAR_DIR; // top-level state files (sessions.json etc.) live directly under var/
export const RUN_DIR = path.resolve(VAR_DIR, 'run');
export const LOG_DIR = path.resolve(VAR_DIR, 'log');
export const TMP_DIR = path.resolve(VAR_DIR, 'tmp');
export const AUTH_DIR = path.resolve(VAR_DIR, 'auth');
export const AGENTS_VAR_DIR = path.resolve(VAR_DIR, 'agents');

export const MAIN_AGENT_FOLDER = 'main';

export const agentDir = (folder: string): string =>
  path.join(AGENTS_DIR, folder);
export const agentVarDir = (folder: string): string =>
  path.join(AGENTS_VAR_DIR, folder);

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

// Streaming UI mode for Telegram (the only channel that supports
// edit-in-place today).
//   'live'     — stream the assistant's text into the placeholder live as
//                tokens arrive. No progress indicator.
//   'progress' — show a live activity indicator (current tool / thinking +
//                elapsed seconds) and replace with the full reply at the
//                end. No mid-stream text.
// Defaults to 'live'.
export const TELEGRAM_STREAM_MODE: 'live' | 'progress' =
  process.env.TELEGRAM_STREAM_MODE === 'progress' ? 'progress' : 'live';

export const EMAIL_DEFAULT_INTERVAL = '1h';
export const EMAIL_HANDLER_PREFIX = 'email-';

// Heartbeat — proactive agent initiative loop
export const HEARTBEAT_HANDLER_PREFIX = 'heartbeat-';

// Warm-start: today's checkpoint + last N days of conversation archives.
export const WARM_START_DAYS = parseInt(process.env.WARM_START_DAYS ?? '2', 10);
export const WARM_START_BUDGET_BYTES = parseInt(
  process.env.WARM_START_BUDGET_BYTES ?? '32768',
  10,
);

// OpenAI key — used by image_generate (gpt-image-2). Long-term memory lives
// in gbrain (separate process); nanoclaw doesn't embed anything itself.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Google AI (Gemini) — image generation via gemini-2.5-flash-image (nano-banana)
export const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';

const HEARTBEAT_BASE_PROMPT = `[HEARTBEAT — Proactive check-in. You are waking up on your own to look around.]

Follow the instructions in <heartbeat_brief> exactly. Do not infer tasks from previous conversations — only act on what the brief says.

MEMORY: Read heartbeat-log.md in your working directory (create it if missing). This is your persistent memory across runs. It tracks what you have already suggested, asked about, or acted on. Use it to avoid repeating yourself:
- Before messaging the user, check if you already suggested or asked about the same thing recently.
- If nothing has changed since your last check-in on a topic, do not bring it up again.
- After each run, append a timestamped entry summarizing what you did or observed (keep the log concise — prune entries older than 7 days).

If nothing needs attention, reply with exactly: HEARTBEAT_OK
If something does need attention, take action (send messages, run commands, etc.) and describe what you did. Do NOT include HEARTBEAT_OK in your response if you took action.`;

// Static handler prompt stored in DB. Brief content is appended at run time.
export const HEARTBEAT_PROMPT = HEARTBEAT_BASE_PROMPT;

export function buildHeartbeatPrompt(brief: string): string {
  const trimmed = brief.trim();
  const briefBlock = trimmed
    ? `<heartbeat_brief>\n${trimmed}\n</heartbeat_brief>`
    : `<heartbeat_brief>\n(empty — no brief configured for this agent)\n</heartbeat_brief>`;
  return `${HEARTBEAT_BASE_PROMPT}\n\n${briefBlock}`;
}

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
