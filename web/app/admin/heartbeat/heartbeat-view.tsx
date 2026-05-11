'use client';
import { useEffect, useState } from 'react';
import { api, type RegisteredAgent } from '@/lib/api';

export function HeartbeatView() {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [folder, setFolder] = useState<string>('main');
  const [log, setLog] = useState<string>('');

  useEffect(() => {
    api
      .agents()
      .then((d) => {
        const folders = uniq(d.agents.map((a) => a.folder));
        setAgents(d.agents);
        if (folders.length > 0 && !folders.includes(folder))
          setFolder(folders[0]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .heartbeat(folder, 80)
        .then((d) => alive && setLog(d.log))
        .catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [folder]);

  const folders = uniq(agents.map((a) => a.folder));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="text-xs text-[color:var(--muted)]">Agent</label>
        <select
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          className="bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-2 py-1 text-sm"
        >
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <pre className="text-xs whitespace-pre-wrap break-words rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3 max-h-[70vh] overflow-y-auto">
        {log || '(no log)'}
      </pre>
    </div>
  );
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
