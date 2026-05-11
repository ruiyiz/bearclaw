import Link from 'next/link';

export default function Home() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
      <div className="max-w-md w-full text-center space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">NanoClaw</h1>
          <p className="text-[color:var(--muted)]">Personal Claude assistant</p>
        </header>
        <nav className="grid grid-cols-1 gap-3">
          <Link
            href="/chat"
            className="block rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] px-5 py-4 text-left hover:border-[color:var(--accent)] transition"
          >
            <div className="text-base font-medium">Chat</div>
            <div className="text-sm text-[color:var(--muted)]">
              Talk to your agent
            </div>
          </Link>
          <Link
            href="/events"
            className="block rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] px-5 py-4 text-left hover:border-[color:var(--accent)] transition"
          >
            <div className="text-base font-medium">Events</div>
            <div className="text-sm text-[color:var(--muted)]">
              See what your agent is doing
            </div>
          </Link>
          <Link
            href="/admin"
            className="block rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] px-5 py-4 text-left hover:border-[color:var(--accent)] transition"
          >
            <div className="text-base font-medium">Admin</div>
            <div className="text-sm text-[color:var(--muted)]">
              Manage skills, handlers, agents, health
            </div>
          </Link>
        </nav>
      </div>
    </main>
  );
}
