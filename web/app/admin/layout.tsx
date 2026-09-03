import { AppShell } from '@/components/app-shell';
import { Nav } from '@/components/Nav';
import { RouteTitle } from '@/components/route-title';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell bare>
      <RouteTitle fallback="Admin" />
      <Nav
        base="Admin"
        items={[
          { href: '/admin/skills', label: 'Skills' },
          { href: '/admin/agents', label: 'Agents' },
          { href: '/admin/context', label: 'Context' },
          { href: '/admin/health', label: 'Health' },
          { href: '/admin/transcripts', label: 'Transcripts' },
        ]}
      />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {children}
      </main>
    </AppShell>
  );
}
