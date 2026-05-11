'use client';
import { useEffect, useState } from 'react';
import { api, type EventRecord } from '@/lib/api';

export function EventsView() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .userEvents(100)
        .then((d) => {
          if (alive) setEvents(d.events);
        })
        .catch((e) => alive && setErr(String(e)));
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const visible = filter
    ? events.filter((e) =>
        (e.type + ' ' + e.payload).toLowerCase().includes(filter.toLowerCase()),
      )
    : events;

  return (
    <main className="flex-1 px-3 py-3 space-y-3 overflow-y-auto">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter events…"
        className="w-full bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-3 py-2 text-sm"
      />
      {err && <div className="text-sm text-red-500">{err}</div>}
      <ul className="space-y-2">
        {visible.map((e) => (
          <li
            key={e.id}
            className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2"
          >
            <div className="flex items-center justify-between text-xs text-[color:var(--muted)]">
              <span>{e.type}</span>
              <span>{new Date(e.emitted_at).toLocaleString()}</span>
            </div>
            <pre className="text-xs mt-1 overflow-x-auto whitespace-pre-wrap break-words">
              {prettyPayload(e.payload)}
            </pre>
          </li>
        ))}
        {visible.length === 0 && (
          <li className="text-sm text-[color:var(--muted)]">No events.</li>
        )}
      </ul>
    </main>
  );
}

function prettyPayload(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
