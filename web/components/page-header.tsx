'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const HEADER_LEFT_ID = 'page-header-left';
export const HEADER_ACTIONS_ID = 'page-header-actions';

export interface Crumb {
  label: string;
  href?: string;
}

function useSlot(id: string): HTMLElement | null {
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // The bar lives in the shell, which mounts first; this still runs after
    // paint, so a page can render before its header lands.
    setNode(document.getElementById(id));
  }, [id]);
  return node;
}

// Every screen names itself in the one top bar rather than growing a header of
// its own, so the trail and the page action always sit in the same place.
export function PageHeader({
  crumbs = [],
  title,
  subtitle,
  actions,
}: {
  crumbs?: Crumb[];
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  const left = useSlot(HEADER_LEFT_ID);
  const right = useSlot(HEADER_ACTIONS_ID);

  return (
    <>
      {left &&
        createPortal(
          <div className="flex min-w-0 items-center gap-1.5">
            {crumbs.map((c) => (
              <span
                key={c.label}
                className="flex shrink-0 items-center gap-1.5"
              >
                {c.href ? (
                  <Link
                    href={c.href}
                    className="text-[13px] text-[color:var(--muted)] underline-offset-4 hover:text-[color:var(--fg)] hover:underline"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-[13px] text-[color:var(--muted)]">
                    {c.label}
                  </span>
                )}
                <span className="text-[color:var(--border)]">/</span>
              </span>
            ))}
            <h1 className="truncate text-[14px] font-semibold tracking-tight">
              {title}
            </h1>
            {subtitle && (
              <span className="ml-1 hidden shrink-0 font-mono text-[11px] text-[color:var(--muted)] sm:block">
                {subtitle}
              </span>
            )}
          </div>,
          left,
        )}
      {right && actions ? createPortal(actions, right) : null}
    </>
  );
}
