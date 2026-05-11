'use client';
import { useEffect, useState } from 'react';
import { api, type HealthCheck } from '@/lib/api';

export function HealthView() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [updated, setUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .health()
        .then((d) => {
          if (!alive) return;
          setChecks(d.checks);
          setUpdated(new Date());
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="space-y-3">
      {updated && (
        <div className="text-xs text-[color:var(--muted)]">
          Updated {updated.toLocaleTimeString()}
        </div>
      )}
      <ul className="space-y-2">
        {checks.map((c) => (
          <li
            key={c.name}
            className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3 flex items-start justify-between gap-3"
          >
            <div>
              <div className="text-sm font-medium">{c.name}</div>
              <div className="text-xs text-[color:var(--muted)]">
                {c.detail}
              </div>
            </div>
            <span
              className={
                'text-xs px-2 py-0.5 rounded-full ' +
                (c.status === 'ok'
                  ? 'bg-emerald-500/20 text-emerald-500'
                  : c.status === 'warn'
                    ? 'bg-amber-500/20 text-amber-500'
                    : 'bg-red-500/20 text-red-500')
              }
            >
              {c.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
