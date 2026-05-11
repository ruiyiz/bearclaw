'use client';
import { useEffect, useState } from 'react';
import { api, type EventRecord } from '@/lib/api';

export function AdminEventsView() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<EventRecord | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .events(200)
        .then((d) => alive && setEvents(d.events))
        .catch(() => {});
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
    <div className="grid md:grid-cols-2 gap-3">
      <div className="space-y-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-3 py-2 text-sm"
        />
        <ul className="space-y-1 max-h-[70vh] overflow-y-auto">
          {visible.map((e) => (
            <li key={e.id}>
              <button
                onClick={() => setSelected(e)}
                className={
                  'w-full text-left rounded-md px-3 py-2 border ' +
                  (selected?.id === e.id
                    ? 'border-[color:var(--accent)] bg-[color:var(--card)]'
                    : 'border-[color:var(--border)] bg-[color:var(--card)] hover:border-[color:var(--accent)]')
                }
              >
                <div className="flex items-center justify-between text-xs text-[color:var(--muted)]">
                  <span>{e.type}</span>
                  <span>{new Date(e.emitted_at).toLocaleString()}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3 min-h-[40vh]">
        {selected ? (
          <>
            <div className="text-sm font-medium">{selected.type}</div>
            <div className="text-xs text-[color:var(--muted)] mb-2">
              {new Date(selected.emitted_at).toLocaleString()} · processed=
              {selected.processed}
            </div>
            <pre className="text-xs whitespace-pre-wrap break-words overflow-x-auto">
              {prettyPayload(selected.payload)}
            </pre>
          </>
        ) : (
          <div className="text-sm text-[color:var(--muted)]">
            Pick an event.
          </div>
        )}
      </div>
    </div>
  );
}

function prettyPayload(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
