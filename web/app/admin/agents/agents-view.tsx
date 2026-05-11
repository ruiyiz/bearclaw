'use client';
import { useEffect, useState } from 'react';
import { api, type RegisteredAgent } from '@/lib/api';

export function AgentsView() {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);

  useEffect(() => {
    api
      .agents()
      .then((d) => setAgents(d.agents))
      .catch(() => {});
  }, []);

  return (
    <ul className="space-y-2">
      {agents.map((a) => (
        <li
          key={a.jid}
          className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3"
        >
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">{a.name}</div>
            <code className="text-xs text-[color:var(--muted)]">{a.jid}</code>
          </div>
          <div className="text-xs text-[color:var(--muted)] mt-1">
            folder={a.folder} · trigger={a.trigger || '—'} · added{' '}
            {new Date(a.added_at).toLocaleString()}
          </div>
        </li>
      ))}
      {agents.length === 0 && (
        <li className="text-sm text-[color:var(--muted)]">
          No agents registered.
        </li>
      )}
    </ul>
  );
}
