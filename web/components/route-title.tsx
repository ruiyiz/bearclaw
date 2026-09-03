'use client';

import { usePathname } from 'next/navigation';

import { PageHeader } from '@/components/page-header';

const TITLES: Record<string, { title: string; subtitle?: string }> = {
  '/chat': { title: 'Chat' },
  '/admin': { title: 'Admin', subtitle: 'skills, agents, context, health' },
  '/admin/skills': { title: 'Skills' },
  '/admin/agents': { title: 'Agents' },
  '/admin/context': { title: 'Context' },
  '/admin/health': { title: 'Health' },
  '/admin/transcripts': { title: 'Transcripts' },
};

// Screens that keep their own inner chrome (chat, admin) still name themselves
// in the shared bar.
export function RouteTitle({ fallback }: { fallback: string }) {
  const path = usePathname() ?? '';
  const key = Object.keys(TITLES)
    .filter((k) => path === k || path.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];
  const entry = TITLES[key] ?? { title: fallback };
  const crumbs =
    key && key.startsWith('/admin/')
      ? [{ label: 'Admin', href: '/admin' }]
      : [];
  return (
    <PageHeader crumbs={crumbs} title={entry.title} subtitle={entry.subtitle} />
  );
}
