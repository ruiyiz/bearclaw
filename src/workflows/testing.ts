import type {
  AgentRunResult,
  AgentRunSpec,
  EngineDeps,
  MatchedEvent,
  ShellRunResult,
  ShellRunSpec,
} from './runtime.js';

export interface FakeDeps extends EngineDeps {
  clock: Date;
  events: MatchedEvent[];
  agentCalls: AgentRunSpec[];
  shellCalls: ShellRunSpec[];
  sends: { folder: string; to?: string; text: string }[];
  agentImpl: (spec: AgentRunSpec) => AgentRunResult;
  shellImpl: (spec: ShellRunSpec) => ShellRunResult;
}

// Engine dependencies with no side effects and a clock the caller moves by
// hand. Used by the workflow tests; not wired into the running process.
export function makeFakeDeps(): FakeDeps {
  const fake: FakeDeps = {
    clock: new Date('2026-09-02T02:00:00.000Z'),
    events: [],
    agentCalls: [],
    shellCalls: [],
    sends: [],
    agentImpl: () => ({ status: 'success', text: 'ok' }),
    shellImpl: () => ({ code: 0, stdout: '', stderr: '' }),

    async runAgent(spec) {
      fake.agentCalls.push(spec);
      return fake.agentImpl(spec);
    },
    async runShell(spec) {
      fake.shellCalls.push(spec);
      return fake.shellImpl(spec);
    },
    async send(spec) {
      fake.sends.push({ folder: spec.folder, to: spec.to, text: spec.text });
      return { targets: [spec.to ?? 'primary'] };
    },
    emitEvent(type, payload) {
      const id = fake.events.length + 1;
      fake.events.push({
        id,
        type,
        payload,
        emitted_at: fake.clock.toISOString(),
      });
      return id;
    },
    latestEventId() {
      return fake.events.length;
    },
    findEvent(type, filter, opts) {
      return (
        fake.events.find((e) => {
          if (e.type !== type) return false;
          if (opts.afterId !== undefined && e.id <= opts.afterId) return false;
          if (opts.sinceIso && e.emitted_at < opts.sinceIso) return false;
          if (!filter) return true;
          const payload = (e.payload ?? {}) as Record<string, unknown>;
          return Object.entries(filter).every(([k, v]) => payload[k] === v);
        }) ?? null
      );
    },
    readTemplateFile() {
      return 'template file body';
    },
    getChatSessionId: () => undefined,
    setChatSessionId: () => {},
    now: () => fake.clock,
    fetch: (async () => {
      throw new Error('fetch not stubbed');
    }) as unknown as typeof fetch,
    env: { OWNER_EMAIL: 'owner@example.com' },
  };
  return fake;
}
