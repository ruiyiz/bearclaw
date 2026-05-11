import Link from 'next/link';

const TILES = [
  { href: '/admin/skills', label: 'Skills', desc: 'Install / sync / remove' },
  { href: '/admin/events', label: 'Events', desc: 'Recent event log' },
  {
    href: '/admin/handlers',
    label: 'Handlers',
    desc: 'Pause / resume / delete',
  },
  {
    href: '/admin/agents',
    label: 'Agents',
    desc: 'Registered agents per channel',
  },
  {
    href: '/admin/health',
    label: 'Health',
    desc: 'Process / DB / channel status',
  },
  {
    href: '/admin/heartbeat',
    label: 'Heartbeat',
    desc: 'Per-agent heartbeat log',
  },
];

export default function AdminHome() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {TILES.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className="rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] px-4 py-3 hover:border-[color:var(--accent)] transition"
        >
          <div className="text-base font-medium">{t.label}</div>
          <div className="text-sm text-[color:var(--muted)]">{t.desc}</div>
        </Link>
      ))}
    </div>
  );
}
