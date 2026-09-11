import type { AgentBackend } from './config.js';

export const MODEL_TIERS = ['fast', 'default', 'advanced', 'frontier'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

type TierMap = Partial<Record<ModelTier, string>>;

const BUILTIN_TIER_MAPS: Record<AgentBackend, TierMap> = {
  'claude-sdk': {
    fast: 'haiku',
    default: 'sonnet',
    advanced: 'opus',
    frontier: 'fable',
  },
  pi: {
    fast: 'pi:openai-codex/gpt-5.6-luna',
    default: 'pi:openai-codex/gpt-5.6-terra',
    advanced: 'pi:openai-codex/gpt-5.6-sol',
    frontier: 'pi:openai-codex/gpt-6-astra',
  },
};

export function isModelTier(value: string | undefined): value is ModelTier {
  return Boolean(value && MODEL_TIERS.includes(value as ModelTier));
}

export function modelTierMap(backend: AgentBackend): TierMap {
  const builtIn = BUILTIN_TIER_MAPS[backend];
  return Object.fromEntries(
    MODEL_TIERS.map((tier) => [
      tier,
      process.env[`MODEL_TIER_${tier.toUpperCase()}`] || builtIn[tier],
    ]).filter(([, model]) => Boolean(model)),
  ) as TierMap;
}

/** Resolve a tier with intentional downward-only fallback. */
export function resolveModelTier(
  tier: ModelTier,
  backend: AgentBackend,
): string | undefined {
  const map = modelTierMap(backend);
  const start = MODEL_TIERS.indexOf(tier);
  for (let i = start; i >= 0; i -= 1) {
    const model = map[MODEL_TIERS[i]];
    if (model) return model;
  }
  return undefined;
}

/** Convert known legacy provider aliases to their portable tier. */
export function tierForModel(model: string | undefined): ModelTier | undefined {
  if (!model) return undefined;
  if (isModelTier(model)) return model;
  const value = model.toLowerCase();
  if (value.includes('haiku') || value.includes('luna')) return 'fast';
  if (value.includes('sonnet') || value.includes('terra')) return 'default';
  if (value.includes('opus') || value.includes('sol')) return 'advanced';
  if (value.includes('fable') || value.includes('astra')) return 'frontier';
  return undefined;
}

/** Tiers are portable. A qualified unknown model remains an expert escape hatch. */
export function resolveModelReference(
  value: string | undefined,
  backend: AgentBackend,
  fallback: ModelTier = 'default',
): string | undefined {
  if (value && !tierForModel(value)) return value;
  const tier = tierForModel(value) ?? fallback;
  return resolveModelTier(tier, backend) ?? value;
}
