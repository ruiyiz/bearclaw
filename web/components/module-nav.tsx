'use client';

import { useEffect, useState } from 'react';

import { Nav } from '@/components/Nav';
import { api } from '@/lib/api';

// One nav for the top-level modules. Chat keeps its own shell; everything else
// hangs off this bar.
export function ModuleNav({ base }: { base: string }) {
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .waits()
        .then((r) => alive && setWaiting(r.waits.length))
        .catch(() => {});
    load();
    const es = new EventSource('/api/workflows/stream');
    es.onmessage = (e) => {
      const evt = JSON.parse(e.data) as { type: string };
      if (evt.type === 'wait.opened' || evt.type === 'wait.resolved') load();
    };
    return () => {
      alive = false;
      es.close();
    };
  }, []);

  return (
    <Nav
      base={base}
      homeHref="/chat"
      items={[
        { href: '/workflows', label: 'Workflows' },
        { href: '/workflows/schedules', label: 'Schedules' },
        { href: '/workflows/events', label: 'Events' },
        { href: '/inbox', label: waiting ? `Inbox (${waiting})` : 'Inbox' },
        { href: '/admin', label: 'Admin' },
      ]}
    />
  );
}
