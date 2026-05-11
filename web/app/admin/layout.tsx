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
        items={[
          { href: '/admin/skills', label: 'Skills' },
          { href: '/admin/events', label: 'Events' },
          { href: '/admin/handlers', label: 'Handlers' },
          { href: '/admin/agents', label: 'Agents' },
          { href: '/admin/health', label: 'Health' },
          { href: '/admin/heartbeat', label: 'Heartbeat' },
        ]}
      />
      <main className="flex-1 px-3 py-3 overflow-y-auto">{children}</main>
    </>
  );
}
