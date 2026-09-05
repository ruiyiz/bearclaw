'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { api, type SetupStatus } from '@/lib/api';
import { useResolvedTheme } from '@/lib/editor';

type StepId =
  | 'password'
  | 'assistant'
  | 'claude'
  | 'documents'
  | 'channels'
  | 'finish';

const STEP_LABELS: Record<StepId, string> = {
  password: 'Password',
  assistant: 'Assistant',
  claude: 'Claude',
  documents: 'Documents',
  channels: 'Channels',
  finish: 'Finish',
};

const COMMON_TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Warsaw',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

const MIN_PASSWORD = 8;
const RESTART_TIMEOUT_MS = 30_000;

const inputClass =
  'w-full rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 text-sm focus:border-[color:var(--accent)] focus:outline-none';

export function SetupWizard() {
  const router = useRouter();
  const theme = useResolvedTheme();

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stepId, setStepId] = useState<StepId>('password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [timezone, setTimezone] = useState('');
  const [authKind, setAuthKind] = useState<'oauth' | 'api'>('oauth');
  const [authValue, setAuthValue] = useState('');
  const [docs, setDocs] = useState({ USER: '', SOUL: '', IDENTITY: '' });
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [docTab, setDocTab] = useState<'USER' | 'SOUL' | 'IDENTITY'>('USER');
  const [telegramToken, setTelegramToken] = useState('');
  const [emailAddress, setEmailAddress] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);

  useEffect(() => {
    api
      .setupStatus()
      .then((s) => {
        setStatus(s);
        setName(s.assistantName);
        setModel(s.model || 'sonnet');
        setTimezone(s.timezone);
        setDocs({
          USER: s.templates.USER,
          SOUL: s.templates.SOUL,
          IDENTITY: s.templates.IDENTITY,
        });
        if (s.hasPassword) {
          // The password step is closed once one exists; the rest of the
          // wizard is owner-only, so an anonymous visitor signs in first.
          void fetch('/api/auth/me', { credentials: 'same-origin' })
            .then((r) => r.json() as Promise<{ authed?: boolean }>)
            .then((me) => {
              if (me.authed) setStepId('assistant');
              else window.location.replace('/login?next=%2Fsetup');
            });
        }
      })
      .catch((e: Error) => setLoadError(String(e)));
  }, []);

  const steps = useMemo<StepId[]>(() => {
    const out: StepId[] = ['password', 'assistant'];
    if (!status?.hasClaudeAuth) out.push('claude');
    out.push('documents', 'channels', 'finish');
    return out;
  }, [status?.hasClaudeAuth]);

  const index = Math.max(0, steps.indexOf(stepId));

  const goto = useCallback(
    (delta: number) => {
      setError(null);
      setNote(null);
      const next = steps[index + delta];
      if (next) setStepId(next);
    },
    [index, steps],
  );

  // The documents step needs a `main` agent to hang IDENTITY.md off, and it
  // should show what is already stored rather than the shipped template.
  useEffect(() => {
    if (stepId !== 'documents' || docsLoaded) return;
    let alive = true;
    void (async () => {
      try {
        const { folders } = await api.agentFolders();
        if (!folders.includes('main')) {
          await api.createAgent({ folder: 'main', name: name || 'Andy' });
        } else if (name) {
          // A boot before the wizard leaves the main agent labelled by its
          // folder. Give it the name the owner just chose.
          const { agents } = await api.agents();
          const main = agents.find((a) => a.folder === 'main');
          if (main && main.name === 'main') {
            await api.renameAgent('main', name);
          }
        }
        const existing = await Promise.all(
          (
            [
              ['USER', 'shared', null, 'USER.md'],
              ['SOUL', 'shared', null, 'SOUL.md'],
              ['IDENTITY', 'agent', 'main', 'IDENTITY.md'],
            ] as const
          ).map(async ([key, scope, folder, file]) => {
            // Absent files answer 404 and come back null; the step then shows
            // the seed template instead.
            const r = await api.contextReadIfExists(scope, folder, file);
            return [key, r?.content ?? null] as const;
          }),
        );
        if (!alive) return;
        setDocs((prev) => {
          const next = { ...prev };
          for (const [key, content] of existing) {
            if (content) next[key] = content;
          }
          return next;
        });
        setDocsLoaded(true);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [stepId, docsLoaded, name]);

  async function submitPassword() {
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    await run(async () => {
      await api.setupPassword(password);
      goto(1);
    });
  }

  async function submitAssistant() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give your assistant a name.');
      return;
    }
    await run(async () => {
      await api.settingsPut({
        ASSISTANT_NAME: trimmed,
        DEFAULT_MODEL: model,
        TZ: timezone.trim() || 'UTC',
      });
      // The starter documents address the assistant by name, so re-render them
      // now that it has one. Anything already edited is left alone.
      if (!docsLoaded) {
        try {
          const s = await api.setupStatus();
          setStatus(s);
          setDocs({
            USER: s.templates.USER,
            SOUL: s.templates.SOUL,
            IDENTITY: s.templates.IDENTITY,
          });
        } catch {
          // Keep the templates already in hand.
        }
      }
      goto(1);
    });
  }

  async function submitClaude() {
    const value = authValue.trim();
    if (!value) {
      setError('Paste a token, or go back if you already have one exported.');
      return;
    }
    const key =
      authKind === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
    await run(async () => {
      await api.settingsPut({ [key]: value }, [key]);
      goto(1);
    });
  }

  async function submitDocuments() {
    await run(async () => {
      await api.contextWrite('shared', null, 'USER.md', docs.USER);
      await api.contextWrite('shared', null, 'SOUL.md', docs.SOUL);
      await api.contextWrite('agent', 'main', 'IDENTITY.md', docs.IDENTITY);
      goto(1);
    });
  }

  async function submitChannels() {
    await run(async () => {
      const token = telegramToken.trim();
      if (token) {
        await api.settingsPut({ TELEGRAM_BOT_TOKEN: token }, [
          'TELEGRAM_BOT_TOKEN',
        ]);
      }
      const address = emailAddress.trim();
      if (address) {
        try {
          await api.wireAgent({
            folder: 'main',
            jid: 'email:main',
            address,
          });
        } catch (e) {
          // Already wired is not a failure worth stopping setup for.
          if (!String(e).includes('409')) throw e;
        }
      }
      goto(1);
    });
  }

  async function refreshWhatsapp() {
    await run(async () => {
      const s = await api.setupStatus();
      setStatus(s);
      setNote(s.whatsapp.paired ? 'WhatsApp is paired.' : 'Still not paired.');
    });
  }

  async function finish() {
    setError(null);
    setBusy(true);
    try {
      await api.setupComplete();
    } catch (e) {
      setBusy(false);
      setError(String(e));
      return;
    }
    setRestarting(true);
    setBusy(false);
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    const poll = async () => {
      try {
        const s = await api.setupStatus();
        if (s.onboarded) {
          router.replace('/chat');
          return;
        }
      } catch {
        // Backend is down mid-restart. Keep waiting.
      }
      if (Date.now() > deadline) {
        setRestartFailed(true);
        return;
      }
      setTimeout(() => void poll(), 1000);
    };
    setTimeout(() => void poll(), 1500);
  }

  async function run(fn: () => Promise<void>) {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const editorExtensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
    ],
    [],
  );

  if (loadError) {
    return (
      <Card>
        <p className="text-sm text-red-500">
          Could not reach BearClaw: {loadError}
        </p>
        <p className="text-sm text-[color:var(--muted)]">
          Start the backend (npm run dev) and reload this page.
        </p>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <p className="text-sm text-[color:var(--muted)]">Loading…</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Progress steps={steps} current={index} />

      <Card>
        {stepId === 'password' && (
          <Step
            title="Choose a password"
            hint="This is the only account. You will use it to sign in to the web UI."
          >
            <input
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`Password (${MIN_PASSWORD}+ characters)`}
              className={inputClass}
            />
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password"
              className={inputClass}
            />
          </Step>
        )}

        {stepId === 'assistant' && (
          <Step
            title="Name your assistant"
            hint="The name it answers to, the model it thinks with, and the timezone it schedules in."
          >
            <Field label="Assistant name">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Andy"
                className={inputClass}
              />
            </Field>
            <Field label="Model">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={inputClass}
              >
                {status.models.map((m) => (
                  <option key={m.alias} value={m.alias}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Timezone">
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                list="setup-timezones"
                placeholder="Europe/London"
                className={inputClass}
              />
              <datalist id="setup-timezones">
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </Field>
          </Step>
        )}

        {stepId === 'claude' && (
          <Step
            title="Connect Claude"
            hint="BearClaw runs the Claude Agent SDK on this machine. It needs one of these."
          >
            <div className="space-y-2">
              <Radio
                checked={authKind === 'oauth'}
                onChange={() => setAuthKind('oauth')}
                label="OAuth token"
                hint="Run claude setup-token in a terminal and paste the result."
              />
              <Radio
                checked={authKind === 'api'}
                onChange={() => setAuthKind('api')}
                label="Anthropic API key"
                hint="A key from console.anthropic.com."
              />
            </div>
            <input
              type="password"
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              placeholder={authKind === 'oauth' ? 'sk-ant-oat…' : 'sk-ant-api…'}
              className={inputClass}
            />
          </Step>
        )}

        {stepId === 'documents' && (
          <Step
            title="Starter documents"
            hint="USER.md and SOUL.md are shared context. IDENTITY.md belongs to the main agent. Edit now or later under Admin, Context."
          >
            <div className="flex gap-1">
              {(['USER', 'SOUL', 'IDENTITY'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setDocTab(tab)}
                  className={
                    'rounded-md px-3 py-1.5 text-xs transition-colors ' +
                    (docTab === tab
                      ? 'bg-[color:var(--accent)] text-white'
                      : 'text-[color:var(--muted)] hover:bg-[color:var(--card)]')
                  }
                >
                  {tab}.md
                </button>
              ))}
            </div>
            <div className="code-surface h-72 overflow-auto rounded-md border border-[color:var(--border)]">
              <CodeMirror
                value={docs[docTab]}
                onChange={(v) => setDocs((d) => ({ ...d, [docTab]: v }))}
                extensions={editorExtensions}
                theme={theme}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: true,
                }}
                style={{ fontSize: 13 }}
              />
            </div>
          </Step>
        )}

        {stepId === 'channels' && (
          <Step
            title="Channels"
            hint="All optional. Anything you skip can be added later under Admin."
          >
            <Field label="Telegram bot token">
              <input
                type="password"
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
                placeholder={
                  status.telegram.configured
                    ? 'Already configured — paste to replace'
                    : 'From @BotFather'
                }
                className={inputClass}
              />
            </Field>

            <Field label="WhatsApp">
              <div className="flex items-center justify-between gap-3 rounded-md border border-[color:var(--border)] px-3 py-2">
                <div className="text-sm">
                  {status.whatsapp.paired ? (
                    <span className="text-[color:var(--fg)]">
                      Paired on this machine.
                    </span>
                  ) : (
                    <span className="text-[color:var(--muted)]">
                      Not paired. Run{' '}
                      <code className="rounded bg-[color:var(--bg-2)] px-1">
                        npm run auth
                      </code>{' '}
                      in the repo, scan the code, then refresh.
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void refreshWhatsapp()}
                  disabled={busy}
                  className="shrink-0 rounded-md border border-[color:var(--border)] px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  Refresh
                </button>
              </div>
            </Field>

            <Field label="Email address">
              <input
                type="email"
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                placeholder="you@example.com"
                className={inputClass}
              />
              <p className="text-xs text-[color:var(--muted)]">
                Wires the email channel to the main agent. Gmail credentials are
                set up separately.
              </p>
            </Field>
          </Step>
        )}

        {stepId === 'finish' && !restarting && (
          <Step
            title="Ready"
            hint="BearClaw reads its configuration at startup, so finishing restarts the process."
          >
            <ul className="space-y-1 text-sm text-[color:var(--muted)]">
              <li>Assistant: {name}</li>
              <li>Model: {model}</li>
              <li>Timezone: {timezone}</li>
              <li>
                Claude auth:{' '}
                {status.hasClaudeAuth || authValue ? 'configured' : 'missing'}
              </li>
            </ul>
          </Step>
        )}

        {restarting && (
          <Step title="Restarting" hint="">
            {restartFailed ? (
              <p className="text-sm text-[color:var(--muted)]">
                BearClaw did not come back. Restart it manually (npm run dev)
                and reload this page.
              </p>
            ) : (
              <p className="text-sm text-[color:var(--muted)]">
                Waiting for BearClaw to come back up…
              </p>
            )}
          </Step>
        )}

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        {note && (
          <p className="mt-3 text-sm text-[color:var(--muted)]">{note}</p>
        )}

        {!restarting && (
          <div className="mt-5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => goto(-1)}
              disabled={busy || index === 0 || stepId === 'assistant'}
              className="rounded-md border border-[color:var(--border)] px-4 py-2 text-sm disabled:opacity-30"
            >
              Back
            </button>
            <div className="flex items-center gap-2">
              {stepId === 'channels' && (
                <button
                  type="button"
                  onClick={() => goto(1)}
                  disabled={busy}
                  className="rounded-md px-3 py-2 text-sm text-[color:var(--muted)] disabled:opacity-40"
                >
                  Skip
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (stepId === 'password') void submitPassword();
                  else if (stepId === 'assistant') void submitAssistant();
                  else if (stepId === 'claude') void submitClaude();
                  else if (stepId === 'documents') void submitDocuments();
                  else if (stepId === 'channels') void submitChannels();
                  else void finish();
                }}
                disabled={busy}
                className="rounded-md bg-[color:var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-40"
              >
                {busy
                  ? 'Working…'
                  : stepId === 'finish'
                    ? 'Finish and restart'
                    : 'Continue'}
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border border-[color:var(--border)] bg-[color:var(--bg-2)] px-5 py-5">
      {children}
    </div>
  );
}

function Step({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-medium">{title}</h2>
        {hint && <p className="text-sm text-[color:var(--muted)]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs uppercase tracking-wide text-[color:var(--muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function Radio({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-[color:var(--border)] px-3 py-2">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-1"
      />
      <span className="text-sm">
        {label}
        <span className="block text-xs text-[color:var(--muted)]">{hint}</span>
      </span>
    </label>
  );
}

function Progress({ steps, current }: { steps: StepId[]; current: number }) {
  return (
    <ol className="flex items-center gap-1.5">
      {steps.map((s, i) => (
        <li key={s} className="flex flex-1 flex-col gap-1.5">
          <span
            className="h-1 rounded-full"
            style={{
              background: i <= current ? 'var(--accent)' : 'var(--border)',
            }}
          />
          <span
            className="text-[10.5px] uppercase tracking-wider"
            style={{ color: i === current ? 'var(--fg)' : 'var(--muted)' }}
          >
            {STEP_LABELS[s]}
          </span>
        </li>
      ))}
    </ol>
  );
}
