'use client';
import { useEffect, useState } from 'react';
import { api, type Handler } from '@/lib/api';

export function HandlersView() {
  const [handlers, setHandlers] = useState<Handler[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  function reload() {
    void api.handlers().then((d) => setHandlers(d.handlers));
  }
  useEffect(reload, []);

  async function pause(id: string) {
    setBusy(id);
    try {
      await api.pauseHandler(id);
      reload();
    } finally {
      setBusy(null);
    }
  }
  async function resume(id: string) {
    setBusy(id);
    try {
      await api.resumeHandler(id);
      reload();
    } finally {
      setBusy(null);
    }
  }
  async function del(id: string) {
    if (!confirm(`Delete handler ${id}?`)) return;
    setBusy(id);
    try {
      await api.deleteHandler(id);
      reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="space-y-2">
      {handlers.map((h) => (
        <li
          key={h.id}
          className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3 space-y-1"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium truncate">{h.id}</div>
            <span
              className={
                'text-xs px-2 py-0.5 rounded-full ' +
                (h.status === 'active'
                  ? 'bg-emerald-500/20 text-emerald-500'
                  : h.status === 'paused'
                    ? 'bg-amber-500/20 text-amber-500'
                    : 'bg-zinc-500/20 text-zinc-500')
              }
            >
              {h.status}
            </span>
          </div>
          <div className="text-xs text-[color:var(--muted)]">
            {h.event_type} · {h.context_mode} · agent={h.group_folder}
            {h.cron && ` · cron=${h.cron}`}
            {h.next_run && ` · next=${new Date(h.next_run).toLocaleString()}`}
            {' · '}runs={h.trigger_count}
          </div>
          <pre className="text-xs whitespace-pre-wrap break-words bg-black/20 rounded p-2">
            {h.prompt}
          </pre>
          <div className="flex gap-2">
            {h.status === 'active' ? (
              <button
                onClick={() => pause(h.id)}
                disabled={busy === h.id}
                className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-amber-500 hover:text-amber-500 disabled:opacity-40"
              >
                Pause
              </button>
            ) : (
              <button
                onClick={() => resume(h.id)}
                disabled={busy === h.id}
                className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-emerald-500 hover:text-emerald-500 disabled:opacity-40"
              >
                Resume
              </button>
            )}
            <button
              onClick={() => del(h.id)}
              disabled={busy === h.id}
              className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-red-500 hover:text-red-500 disabled:opacity-40"
            >
              Delete
            </button>
          </div>
        </li>
      ))}
      {handlers.length === 0 && (
        <li className="text-sm text-[color:var(--muted)]">No handlers.</li>
      )}
    </ul>
  );
}
