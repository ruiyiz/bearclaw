// Time and status formatting shared by every workflow screen.

export function statusColor(status: string | null): string {
  switch (status) {
    case 'succeeded':
      return 'text-[color:var(--ok)]';
    case 'failed':
      return 'text-[color:var(--danger)]';
    case 'running':
      return 'text-[color:var(--accent)]';
    case 'waiting':
      return 'text-[color:var(--warn)]';
    default:
      return 'text-[color:var(--muted)]';
  }
}

export function shortTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace('T', ' ').slice(0, 16);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const days = Math.round(
    (new Date(d.toDateString()).getTime() -
      new Date(now.toDateString()).getTime()) /
      86_400_000,
  );
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
