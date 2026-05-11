'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Item {
  href: string;
  label: string;
}

export function Nav({ items, base }: { items: Item[]; base: string }) {
  const path = usePathname();
  return (
    <nav className="sticky top-0 z-10 backdrop-blur bg-[color:var(--bg)]/80 border-b border-[color:var(--border)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <Link
          href="/"
          aria-label="Home"
          className="shrink-0 text-base leading-none px-2 py-1.5 rounded-md hover:bg-[color:var(--card)] text-[color:var(--muted)]"
        >
          ←
        </Link>
        <div className="shrink-0 text-sm font-medium pr-1">{base}</div>
        <div
          className="relative flex-1 min-w-0"
          // Edge fade hints there's more to scroll on overflow.
          style={{
            maskImage:
              'linear-gradient(to right, transparent 0, black 4%, black 96%, transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to right, transparent 0, black 4%, black 96%, transparent 100%)',
          }}
        >
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {items.map((it) => {
              const active =
                path === it.href || path?.startsWith(it.href + '/');
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={
                    'shrink-0 text-sm px-3 py-1.5 rounded-md whitespace-nowrap ' +
                    (active
                      ? 'bg-[color:var(--accent)] text-white'
                      : 'hover:bg-[color:var(--card)] text-[color:var(--fg)]')
                  }
                >
                  {it.label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
