import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT } from './templates.js';

// launchd agents are machine-local: the templates in launchd/ carry
// {{placeholders}} for the paths, and setup renders them per machine. Nothing
// that belongs in the config database may be set here, because environment
// variables win over stored settings.

export interface PlistVars {
  NODE_PATH: string;
  PROJECT_ROOT: string;
  HOME: string;
  /** Extra EnvironmentVariables entries. Machine-local values only. */
  extraEnv?: Record<string, string>;
}

export interface LaunchAgent {
  label: string;
  template: string;
  target: string;
}

export const LAUNCH_AGENT_LABELS = ['com.bearclaw', 'com.bearclaw.web'];

export function launchAgentsDir(): string {
  return (
    process.env.BEARCLAW_LAUNCH_AGENTS_DIR ||
    path.join(os.homedir(), 'Library', 'LaunchAgents')
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function injectEnv(text: string, extraEnv: Record<string, string>): string {
  const entries = Object.entries(extraEnv);
  if (entries.length === 0) return text;
  const marker = /(<key>EnvironmentVariables<\/key>\s*\n(\s*)<dict>\n)/;
  const match = marker.exec(text);
  if (!match) return text;
  const indent = `${match[2]}    `;
  const block = entries
    .map(
      ([key, value]) =>
        `${indent}<key>${escapeXml(key)}</key>\n${indent}<string>${escapeXml(value)}</string>\n`,
    )
    .join('');
  return text.replace(marker, `$1${block}`);
}

export function renderPlist(templateText: string, vars: PlistVars): string {
  const { extraEnv, ...values } = vars;
  const rendered = templateText.replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (match, key: string) =>
      key in values ? escapeXml(values[key as keyof typeof values]) : match,
  );
  return injectEnv(rendered, extraEnv ?? {});
}

/**
 * Machine-local environment the plists need. BEARCLAW_HOME only travels when
 * the install is somewhere other than ~/.bearclaw; the default is derived, and
 * pinning it would break a restored bundle on a different account.
 */
export function machineEnv(home = os.homedir()): Record<string, string> {
  const configured = process.env.BEARCLAW_HOME;
  if (!configured) return {};
  if (path.resolve(configured) === path.join(home, '.bearclaw')) return {};
  return { BEARCLAW_HOME: path.resolve(configured) };
}

export function planLaunchAgents(
  targetDir = launchAgentsDir(),
  projectRoot = PROJECT_ROOT,
): LaunchAgent[] {
  return LAUNCH_AGENT_LABELS.map((label) => ({
    label,
    template: path.join(projectRoot, 'launchd', `${label}.plist`),
    target: path.join(targetDir, `${label}.plist`),
  }));
}

export function writeLaunchAgents(
  opts: {
    targetDir?: string;
    projectRoot?: string;
    nodePath?: string;
    home?: string;
    extraEnv?: Record<string, string>;
  } = {},
): LaunchAgent[] {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const home = opts.home ?? os.homedir();
  const targetDir = opts.targetDir ?? launchAgentsDir();
  const agents = planLaunchAgents(targetDir, projectRoot);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
  for (const agent of agents) {
    const text = renderPlist(fs.readFileSync(agent.template, 'utf-8'), {
      NODE_PATH: opts.nodePath ?? process.execPath,
      PROJECT_ROOT: projectRoot,
      HOME: home,
      extraEnv: opts.extraEnv ?? machineEnv(home),
    });
    fs.writeFileSync(agent.target, text);
  }
  return agents;
}
