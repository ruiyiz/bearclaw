'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { CommandPalette } from '@/components/command-palette';
import { HEADER_ACTIONS_ID, HEADER_LEFT_ID } from '@/components/page-header';
import { api } from '@/lib/api';

interface Item {
  href: string;
  label: string;
  match?: (path: string) => boolean;
}

const AUTOMATION: Item[] = [
  {
    href: '/workflows',
    label: 'Workflows',
    match: (p) =>
      p === '/workflows' ||
      (p.startsWith('/workflows/') &&
        !p.startsWith('/workflows/schedules') &&
        !p.startsWith('/workflows/events')),
  },
  { href: '/workflows/schedules', label: 'Schedules' },
  { href: '/workflows/events', label: 'Events' },
];

function isActive(item: Item, path: string): boolean {
  if (item.match) return item.match(path);
  return path === item.href || path.startsWith(`${item.href}/`);
}

function Icon({ name }: { name: string }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (name === 'chat')
    return (
      <svg {...common}>
        <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5a8 8 0 0 1 8-11h2a8 8 0 0 1 8 5z" />
      </svg>
    );
  if (name === 'workflows')
    return (
      <svg {...common}>
        <path d="M5 4v6a3 3 0 0 0 3 3h8" />
        <path d="M19 20v-6a3 3 0 0 0-3-3H8" />
      </svg>
    );
  if (name === 'schedules')
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    );
  if (name === 'events')
    return (
      <svg {...common}>
        <path d="M3 12h4l2.5-6 4 13 2.5-7H21" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function AppShell({
  children,
  bare = false,
}: {
  children: React.ReactNode;
  bare?: boolean;
}) {
  const path = usePathname() ?? '';
  const [waiting, setWaiting] = useState(0);
  const [autoOpen, setAutoOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('nc.autoOpen');
      if (saved === '0') setAutoOpen(false);
    } catch {
      /* private mode */
    }
  }, []);

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

  useEffect(() => setDrawer(false), [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const autoActive = AUTOMATION.some((i) => isActive(i, path));

  const nav = (
    <nav className="flex min-h-0 grow flex-col gap-0.5 overflow-y-auto px-3 pb-3">
      <SideLink
        href="/chat"
        label="Chat"
        icon="chat"
        active={path.startsWith('/chat')}
      />

      <button
        type="button"
        onClick={() => {
          const next = !autoOpen;
          setAutoOpen(next);
          try {
            localStorage.setItem('nc.autoOpen', next ? '1' : '0');
          } catch {
            /* private mode */
          }
        }}
        className="mt-3 flex items-center gap-1.5 px-2 py-1 text-[10.5px] uppercase tracking-wider"
        style={{
          color: autoActive && !autoOpen ? 'var(--fg)' : 'var(--muted)',
        }}
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          style={{
            transform: autoOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 120ms ease',
          }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        Automation
        {!autoOpen && waiting > 0 && (
          <span className="ml-1 rounded-full bg-[color:var(--accent)] px-1.5 text-[10px] leading-4 text-[color:var(--on-accent)]">
            {waiting}
          </span>
        )}
      </button>

      {autoOpen &&
        AUTOMATION.map((item) => (
          <SideLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.label.toLowerCase()}
            active={isActive(item, path)}
            badge={item.href === '/workflows' ? waiting : 0}
          />
        ))}

      <div className="mt-3">
        <SideLink
          href="/admin"
          label="Admin"
          icon="admin"
          active={path.startsWith('/admin')}
        />
      </div>
    </nav>
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-[236px] shrink-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-2)] md:flex">
        <Link
          href="/chat"
          className="flex items-center gap-2.5 px-4 py-4 text-[14px] font-semibold tracking-tight"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" width={24} height={24} />
          bearclaw
        </Link>
        {nav}
      </aside>

      {drawer && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/50 md:hidden"
            onClick={() => setDrawer(false)}
          />
          <aside className="fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-2)] md:hidden">
            <div className="flex items-center justify-between px-4 py-4">
              <span className="text-[14px] font-semibold">bearclaw</span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawer(false)}
                className="px-2 text-[color:var(--muted)]"
              >
                ✕
              </button>
            </div>
            {nav}
          </aside>
        </>
      )}

      <div className="flex min-w-0 grow flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-[color:var(--border)] bg-[color:var(--bg-2)] px-3 md:px-5">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
            className="rounded-md px-1.5 py-1 text-[color:var(--muted)] hover:text-[color:var(--fg)] md:hidden"
          >
            <Icon name="menu" />
          </button>
          <div id={HEADER_LEFT_ID} className="flex min-w-0 grow items-center" />
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="hidden h-7 items-center gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2.5 text-[color:var(--muted)] hover:text-[color:var(--fg)] sm:flex"
          >
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <span className="text-[12px]">Search</span>
            <span className="rounded border border-[color:var(--border)] px-1 font-mono text-[10px]">
              K
            </span>
          </button>
          <div
            id={HEADER_ACTIONS_ID}
            className="flex shrink-0 items-center gap-2"
          />
        </header>
        {bare ? (
          <div className="flex min-h-0 grow flex-col">{children}</div>
        ) : (
          <main className="min-h-0 grow overflow-y-auto px-4 py-4">
            {children}
          </main>
        )}
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

function SideLink({
  href,
  label,
  icon,
  active,
  badge = 0,
}: {
  href: string;
  label: string;
  icon: string;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors"
      style={{
        background: active ? 'var(--card)' : 'transparent',
        color: active ? 'var(--fg)' : 'var(--muted)',
        boxShadow: active ? 'inset 2px 0 0 var(--accent)' : 'none',
      }}
    >
      <Icon name={icon} />
      <span className="grow truncate">{label}</span>
      {badge > 0 && (
        <span className="rounded-full bg-[color:var(--accent)] px-1.5 text-[10px] leading-4 text-[color:var(--on-accent)]">
          {badge}
        </span>
      )}
    </Link>
  );
}
