'use client';
import { useEffect, useState } from 'react';
import {
  applyFont,
  FONT_DEFAULT,
  FONT_OPTIONS,
  loadFont,
  saveFont,
} from '@/lib/font';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const [font, setFont] = useState<string>(FONT_DEFAULT);

  // Sync the picker with whatever is currently active when the dialog opens.
  useEffect(() => {
    if (open) setFont(loadFont());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function pick(id: string) {
    setFont(id);
    applyFont(id);
    saveFont(id);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-xl border border-[color:var(--border)] bg-[color:var(--bg-2,#14171d)] shadow-2xl">
        <header className="flex items-center justify-between px-5 py-3 border-b border-[color:var(--border)]">
          <h2 id="settings-title" className="text-base font-semibold">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[color:var(--muted)] hover:text-[color:var(--fg)] text-lg leading-none px-1"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-4 space-y-4">
          <section>
            <div className="text-xs uppercase tracking-wide text-[color:var(--muted)] mb-2">
              Font
            </div>
            <div className="space-y-1">
              {FONT_OPTIONS.map((opt) => {
                const active = font === opt.id;
                return (
                  <button
                    type="button"
                    key={opt.id}
                    onClick={() => pick(opt.id)}
                    style={{ fontFamily: `var(--font-${opt.id})` }}
                    className={
                      'w-full flex items-center gap-3 px-3 py-2 rounded-md border text-left transition-colors ' +
                      (active
                        ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10'
                        : 'border-[color:var(--border)] hover:bg-[color:var(--card)]')
                    }
                  >
                    <span
                      className={
                        'w-3.5 h-3.5 rounded-full border ' +
                        (active
                          ? 'border-[color:var(--accent)] bg-[color:var(--accent)]'
                          : 'border-[color:var(--muted)]')
                      }
                      aria-hidden="true"
                    />
                    <span className="flex-1">
                      <div className="text-sm font-medium">{opt.label}</div>
                      <div className="text-xs text-[color:var(--muted)]">
                        {opt.description}
                      </div>
                    </span>
                    <span className="text-sm text-[color:var(--muted)]">
                      The quick brown fox 0123
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
        <footer className="px-5 py-3 border-t border-[color:var(--border)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md bg-[color:var(--accent)] text-white text-sm font-medium hover:brightness-110"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
