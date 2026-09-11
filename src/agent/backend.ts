import { AGENT_BACKEND, type AgentBackend } from '../config.js';
import { tierForModel } from '../model-tiers.js';

export type { AgentBackend };

export function activeAgentBackend(): AgentBackend {
  return AGENT_BACKEND;
}

export function isPiModel(model: string | undefined): boolean {
  return Boolean(model?.startsWith('pi:'));
}

export function stripPiPrefix(model: string): string {
  return model.startsWith('pi:') ? model.slice(3) : model;
}

/** Replace old Claude aliases with the configured, provider-qualified Pi model. */
export function migrateModelOverrides(
  overrides: Record<string, string>,
  backend: AgentBackend,
  defaultModel: string,
): string[] {
  void backend;
  void defaultModel;
  const migrated: string[] = [];
  for (const [folder, model] of Object.entries(overrides)) {
    const tier = tierForModel(model);
    if (!tier) continue;
    overrides[folder] = tier;
    migrated.push(folder);
  }
  return migrated;
}
