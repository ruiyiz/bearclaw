import { Nav } from '@/components/Nav';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav
        base="Admin"
        homeHref="/workflows"
        items={[
          { href: '/admin/skills', label: 'Skills' },
          { href: '/admin/agents', label: 'Agents' },
          { href: '/admin/context', label: 'Context' },
          { href: '/admin/health', label: 'Health' },
          { href: '/admin/transcripts', label: 'Transcripts' },
        ]}
      />
      <main className="flex-1 px-3 py-3 overflow-y-auto">{children}</main>
    </>
  );
}
