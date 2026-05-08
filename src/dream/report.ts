/**
 * Dream Cycle — Hypnopompic Report (main agent only).
 *
 * Composes a brief, date-stamped channel message summarizing the night's
 * dream cycle and sends it to main's default channel via IPC. The narrative
 * itself is written by a subagent with no tools; sending is done by writing
 * an IPC message file (which the existing watcher delivers).
 */

import fs from 'fs';
import path from 'path';

import {
  DREAM_REPORT_CHANNEL,
  MAIN_AGENT_FOLDER,
  RUN_DIR,
  agentVarDir,
} from '../config.js';
import { getRecentDreamRunsByFolder } from '../db.js';
import { logger } from '../logger.js';
import { RegisteredAgent } from '../types.js';
import { runDreamSubagent } from './subagent.js';
import { runSharedPromotion, SharedPromotion } from './shared.js';

interface PerAgentCounts {
  agentFolder: string;
  promoted: number;
}

interface ReportInput {
  perAgent: PerAgentCounts[];
  shared: SharedPromotion[];
  mainDreamPath: string;
}

const SYSTEM_PROMPT = `You write the Hypnopompic Report — a short, date-stamped daily message summarizing what was consolidated overnight. The user reads this in a chat, on a phone.

Voice: warm, reflective, first-person. Like surfacing from sleep with a clear sense of the day's distillation. No emojis. No hashtags.

Length: 60–140 words. Subject line is fixed and provided.

Structure:
  - First line: subject (verbatim from input).
  - One short paragraph naming what consolidated across agents (use shared themes if present).
  - One short paragraph noting per-agent counts and the agent that contributed most, if asymmetric.
  - One closing sentence — quietly reflective, not summary-of-summary.

You have NO tools. Output ONLY the message text. Do not produce JSON, code blocks, or commentary.`;

function buildPrompt(input: ReportInput): string {
  const today = new Date().toISOString().slice(0, 10);
  const subject = `Hypnopompic Report — ${today}`;
  const totalPromoted = input.perAgent.reduce((s, a) => s + a.promoted, 0);
  const sharedThemes = new Set<string>();
  for (const s of input.shared) {
    // SharedPromotion doesn't carry themes directly; pull from main dream path if useful
    void s;
  }
  // Read main's dream diary if available, to give the subagent some color
  let dreamExcerpt = '';
  try {
    if (fs.existsSync(input.mainDreamPath)) {
      dreamExcerpt = fs
        .readFileSync(input.mainDreamPath, 'utf-8')
        .slice(0, 800);
    }
  } catch {
    /* ignore */
  }

  return [
    `Subject: ${subject}`,
    '',
    `Overnight totals:`,
    `  - engrams promoted across agents: ${totalPromoted}`,
    `  - shared MEMORY.md promotions: ${input.shared.length}`,
    `  - per-agent: ${input.perAgent.map((a) => `${a.agentFolder}=${a.promoted}`).join(', ') || '(none)'}`,
    '',
    'Shared promotions (text):',
    input.shared.length
      ? input.shared
          .map(
            (s) =>
              `  - ${s.text.replace(/\s+/g, ' ').slice(0, 200)} (across: ${s.agents.join(', ')})`,
          )
          .join('\n')
      : '  (none)',
    '',
    "Main agent's diary excerpt:",
    dreamExcerpt ? dreamExcerpt : '  (empty)',
    '',
    sharedThemes.size ? `Themes: ${[...sharedThemes].join(', ')}` : '',
    '',
    'Now write the Hypnopompic Report message.',
  ].join('\n');
}

function pickReportChatJid(
  registeredAgentJids: Record<string, { folder: string; primary?: boolean }>,
): string | null {
  if (DREAM_REPORT_CHANNEL) return DREAM_REPORT_CHANNEL;
  // Prefer a channel explicitly flagged as primary for the main folder.
  for (const [jid, agent] of Object.entries(registeredAgentJids)) {
    if (agent.folder === MAIN_AGENT_FOLDER && agent.primary) return jid;
  }
  // Fall back to the first registered channel for the main folder.
  for (const [jid, agent] of Object.entries(registeredAgentJids)) {
    if (agent.folder === MAIN_AGENT_FOLDER) return jid;
  }
  return null;
}

function writeReportIpc(text: string, chatJid: string | null): void {
  const ipcDir = path.join(RUN_DIR, 'ipc', MAIN_AGENT_FOLDER, 'messages');
  fs.mkdirSync(ipcDir, { recursive: true });
  const filename = `${Date.now()}-hypnopompic-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(ipcDir, filename);
  const data = {
    type: 'message',
    chatJid: chatJid || '',
    text,
    agentFolder: MAIN_AGENT_FOLDER,
    timestamp: new Date().toISOString(),
  };
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filepath);
}

export async function runHypnopompicReport(
  varDir: string,
  input: ReportInput,
  registeredAgents: Record<string, { folder: string; primary?: boolean }>,
): Promise<void> {
  const totalPromoted = input.perAgent.reduce((s, a) => s + a.promoted, 0);
  if (totalPromoted === 0 && input.shared.length === 0) {
    // Skip report when nothing happened — don't spam the channel.
    logger.debug('Hypnopompic Report skipped: no consolidations');
    return;
  }

  const out = await runDreamSubagent({
    prompt: buildPrompt(input),
    cwd: varDir,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: [],
    timeoutMs: 4 * 60 * 1000,
  });

  const today = new Date().toISOString().slice(0, 10);
  const fallback =
    `Hypnopompic Report — ${today}\n\n` +
    `Overnight: ${totalPromoted} engrams promoted across agents` +
    (input.shared.length ? `, ${input.shared.length} shared.` : '.');

  const text =
    out.status === 'success' && out.result?.trim()
      ? out.result.trim()
      : fallback;
  const chatJid = pickReportChatJid(registeredAgents);

  writeReportIpc(text, chatJid);
  logger.info(
    { chatJid, totalPromoted, shared: input.shared.length },
    'Hypnopompic Report queued',
  );
}

/**
 * Post-cycle entrypoint. Runs after every per-agent dream cycle has
 * completed (separate handler, later cron). Aggregates each agent's
 * promotions from `dream_runs`, runs shared promotion across the now-final
 * ENGRAMs, then composes and queues the Hypnopompic Report.
 */
export async function runDreamReportCycle(deps: {
  registeredAgents: () => Record<string, RegisteredAgent>;
}): Promise<void> {
  const folders = new Set<string>([MAIN_AGENT_FOLDER]);
  for (const a of Object.values(deps.registeredAgents())) folders.add(a.folder);

  // Look back ~12h to find each folder's most-recent successful run.
  const sinceUnix = Math.floor(Date.now() / 1000) - 12 * 3600;
  const recent = getRecentDreamRunsByFolder(sinceUnix);
  const promotedByFolder = new Map<string, number>();
  for (const r of recent) promotedByFolder.set(r.agent_folder, r.deep_promoted);

  const perAgent: Array<{ agentFolder: string; promoted: number }> = [];
  for (const folder of folders) {
    perAgent.push({
      agentFolder: folder,
      promoted: promotedByFolder.get(folder) ?? 0,
    });
  }

  const shared = runSharedPromotion([...folders]);

  const mainVar = agentVarDir(MAIN_AGENT_FOLDER);
  const today = new Date().toISOString().slice(0, 10);
  const mainDreamPath = path.join(mainVar, 'dreams', `${today}.md`);

  await runHypnopompicReport(
    mainVar,
    { perAgent, shared, mainDreamPath },
    deps.registeredAgents(),
  );
}
