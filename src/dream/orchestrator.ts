/**
 * Dream Cycle — orchestrator.
 *
 * Bundles the daily session reset with the dream phases. Called by the
 * dream-{folder} handler. The reset always happens; phases run only if
 * there is enough new material.
 */

import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  DREAM_LOOKBACK_DAYS,
  DREAM_MIN_NEW_ENTRIES,
  MAIN_AGENT_FOLDER,
  agentDir as agentPersistentDir,
  agentVarDir,
} from '../config.js';
import {
  finishDreamRun,
  pruneOldDreamCandidates,
  startDreamRun,
} from '../db.js';
import { logger } from '../logger.js';
import { flushBeforeSessionClear } from '../agent/memory-flusher.js';
import { embedPendingChunks } from '../agent/memory-embed.js';
import { saveJson } from '../utils/json.js';
import { Session, RegisteredAgent } from '../types.js';
import { runDeepPhase } from './deep.js';
import { runLightPhase } from './light.js';
import { runNarratePhase } from './narrate.js';
import { runRemPhase } from './rem.js';
import { runHypnopompicReport } from './report.js';
import { runSharedPromotion } from './shared.js';

interface DreamOrchestratorDeps {
  registeredAgents: () => Record<string, RegisteredAgent>;
  getSessions: () => Session;
  saveSessions: () => void;
}

function countNewDailyEntries(varDir: string, lookbackDays: number): number {
  const memDir = path.join(varDir, 'memory');
  if (!fs.existsSync(memDir)) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let total = 0;
  for (const f of fs.readdirSync(memDir)) {
    if (!f.endsWith('.md')) continue;
    const m = f.match(/(\d{4}-\d{2}-\d{2})/);
    if (!m || m[1] < cutoffStr) continue;
    try {
      const content = fs.readFileSync(path.join(memDir, f), 'utf-8');
      total += (content.match(/^## /gm) || []).length;
    } catch {
      /* ignore */
    }
  }
  return total;
}

/**
 * Run the dream cycle for one agent. Always performs the session reset; runs
 * phases only when there is enough new material since the last cycle.
 */
export async function runDreamCycle(
  agentFolder: string,
  deps: DreamOrchestratorDeps,
): Promise<void> {
  const persistentDir = agentPersistentDir(agentFolder);
  const varDir = agentVarDir(agentFolder);
  fs.mkdirSync(persistentDir, { recursive: true });
  fs.mkdirSync(varDir, { recursive: true });

  // Step 0: Reset (always)
  const sessions = deps.getSessions();
  if (sessions[agentFolder]) {
    flushBeforeSessionClear(agentFolder, sessions[agentFolder]);
    delete sessions[agentFolder];
    deps.saveSessions();
    logger.info({ agentFolder }, 'Dream: session reset');
  }

  // Skip phases if too little new content
  const newEntries = countNewDailyEntries(varDir, DREAM_LOOKBACK_DAYS);
  if (newEntries < DREAM_MIN_NEW_ENTRIES) {
    logger.info(
      { agentFolder, newEntries, threshold: DREAM_MIN_NEW_ENTRIES },
      'Dream: phases skipped (insufficient new content)',
    );
    return;
  }

  const runId = startDreamRun(agentFolder);

  try {
    // Best-effort: ensure embeddings are up to date for the relevance signal.
    await embedPendingChunks();

    // Light
    const lightCount = runLightPhase(agentFolder, varDir);

    // REM
    const remCount = await runRemPhase(agentFolder, varDir);

    // Deep
    const promoted = runDeepPhase(agentFolder);

    // Narrate
    const dreamPath = await runNarratePhase(agentFolder, varDir, promoted);

    // Main-only: shared promotion + Hypnopompic Report
    let sharedPromoted = 0;
    if (agentFolder === MAIN_AGENT_FOLDER) {
      const folders = new Set(
        Object.values(deps.registeredAgents()).map((a) => a.folder),
      );
      folders.add(MAIN_AGENT_FOLDER);
      const sharedResults = runSharedPromotion([...folders]);
      sharedPromoted = sharedResults.length;

      // Build per-agent counts from dream_runs in the past 24 hours
      const perAgent: Array<{ agentFolder: string; promoted: number }> = [];
      perAgent.push({
        agentFolder: MAIN_AGENT_FOLDER,
        promoted: promoted.length,
      });
      // Other agents' counts are unknown to main directly — we approximate by
      // counting lines in their ENGRAM.md added today. Light because reading
      // the diary is the more authoritative signal.
      for (const folder of folders) {
        if (folder === MAIN_AGENT_FOLDER) continue;
        const otherEngram = path.join(agentPersistentDir(folder), 'ENGRAM.md');
        if (!fs.existsSync(otherEngram)) {
          perAgent.push({ agentFolder: folder, promoted: 0 });
          continue;
        }
        const today = new Date().toISOString().slice(0, 10);
        const content = fs.readFileSync(otherEngram, 'utf-8');
        const todayLines = (
          content.match(new RegExp(`promoted_at"\\s*:\\s*"${today}"`, 'g')) ||
          []
        ).length;
        perAgent.push({ agentFolder: folder, promoted: todayLines });
      }

      await runHypnopompicReport(
        varDir,
        {
          perAgent,
          shared: sharedResults,
          mainDreamPath:
            dreamPath ??
            path.join(
              varDir,
              'dreams',
              `${new Date().toISOString().slice(0, 10)}.md`,
            ),
        },
        deps.registeredAgents(),
      );
    }

    // Prune old, unpromoted candidates beyond 2× lookback window
    pruneOldDreamCandidates(DREAM_LOOKBACK_DAYS * 2 * 86400);

    finishDreamRun(runId, 'success', {
      lightCount,
      remCount,
      deepPromoted: promoted.length,
      sharedPromoted,
    });
    logger.info(
      {
        agentFolder,
        lightCount,
        remCount,
        deepPromoted: promoted.length,
        sharedPromoted,
      },
      'Dream cycle complete',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishDreamRun(runId, 'error', { error: msg });
    logger.error({ agentFolder, err: msg }, 'Dream cycle errored');
  }
}

/**
 * Wrapper used by the event-bus dispatcher when it sees a `dream-` prefixed
 * handler. Avoids the need for the bus to know about Session storage shape.
 */
export async function dispatchDreamHandler(
  agentFolder: string,
  deps: DreamOrchestratorDeps,
): Promise<void> {
  await runDreamCycle(agentFolder, deps);
}

/** Best-effort one-shot trigger for a manual dream run (used by ops scripts). */
export async function triggerDreamFor(
  agentFolder: string,
  deps: DreamOrchestratorDeps,
): Promise<void> {
  await runDreamCycle(agentFolder, deps);
}

/** Save sessions JSON helper used by orchestrator deps. */
export function saveSessionsFile(sessions: Session): void {
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}
