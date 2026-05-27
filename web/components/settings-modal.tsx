'use client';
import { useEffect, useState } from 'react';
import {
  applyFont,
  applyFontSize,
  FONT_DEFAULT,
  FONT_OPTIONS,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_OPTIONS,
  loadFont,
  loadFontSize,
  saveFont,
  saveFontSize,
  type FontSize,
} from '@/lib/font';
import {
  KEEP_FOCUS_DEFAULT,
  loadKeepFocusOnSend,
  saveKeepFocusOnSend,
} from '@/lib/prefs';
import {
  applyTheme,
  loadTheme,
  saveTheme,
  THEME_DEFAULT,
  THEME_OPTIONS,
  type ThemeMode,
} from '@/lib/theme';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const [font, setFont] = useState<string>(FONT_DEFAULT);
  const [fontSize, setFontSize] = useState<FontSize>(FONT_SIZE_DEFAULT);
  const [keepFocus, setKeepFocus] = useState<boolean>(KEEP_FOCUS_DEFAULT);
  const [theme, setTheme] = useState<ThemeMode>(THEME_DEFAULT);

  // Sync controls with the currently persisted values whenever the dialog
  // opens, so changes made via other tabs / settings flows are reflected.
  useEffect(() => {
    if (!open) return;
    setFont(loadFont());
    setFontSize(loadFontSize());
    setKeepFocus(loadKeepFocusOnSend());
    setTheme(loadTheme());
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

  function toggleKeepFocus() {
    const next = !keepFocus;
    setKeepFocus(next);
    saveKeepFocusOnSend(next);
  }

  function pickTheme(mode: ThemeMode) {
    setTheme(mode);
    applyTheme(mode);
    saveTheme(mode);
  }

  function pickFontSize(id: FontSize) {
    setFontSize(id);
    applyFontSize(id);
    saveFontSize(id);
  }

  return (
    <>
      {/* Transparent click-catcher — no dim/blur so the chat behind stays
          fully visible, giving real-time preview of theme/font/size. */}
      {open && (
        <div
          className="fixed inset-0 z-40"
          aria-hidden="true"
          onClick={onClose}
        />
      )}
      <aside
        role="dialog"
        aria-modal="false"
        aria-labelledby="settings-title"
        aria-hidden={!open}
        className={
          'fixed top-0 right-0 h-dvh w-[22rem] max-w-[90vw] z-50 ' +
          'bg-[color:var(--bg-2,#14171d)] border-l border-[color:var(--border)] shadow-2xl ' +
          'flex flex-col transform transition-transform duration-200 ' +
          (open ? 'translate-x-0' : 'translate-x-full pointer-events-none')
        }
      >
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
        <div className="px-5 py-4 space-y-4 flex-1 overflow-y-auto">
          <section>
            <div className="text-xs uppercase tracking-wide text-[color:var(--muted)] mb-2">
              Theme
            </div>
            <div className="grid grid-cols-3 gap-2">
              {THEME_OPTIONS.map((opt) => {
                const active = theme === opt.id;
                return (
                  <button
                    type="button"
                    key={opt.id}
                    onClick={() => pickTheme(opt.id)}
                    className={
                      'px-3 py-2 rounded-md border text-sm font-medium transition-colors ' +
                      (active
                        ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--fg)]'
                        : 'border-[color:var(--border)] text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-[color:var(--card)]')
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </section>
          <section>
            <div className="text-xs uppercase tracking-wide text-[color:var(--muted)] mb-2">
              Font size
            </div>
            <div className="grid grid-cols-4 gap-2">
              {FONT_SIZE_OPTIONS.map((opt) => {
                const active = fontSize === opt.id;
                return (
                  <button
                    type="button"
                    key={opt.id}
                    onClick={() => pickFontSize(opt.id)}
                    className={
                      'px-2 py-2 rounded-md border text-sm font-medium transition-colors ' +
                      (active
                        ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--fg)]'
                        : 'border-[color:var(--border)] text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-[color:var(--card)]')
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </section>
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
          <section>
            <div className="text-xs uppercase tracking-wide text-[color:var(--muted)] mb-2">
              Composer
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={keepFocus}
              onClick={toggleKeepFocus}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--card)] text-left transition-colors"
            >
              <span className="flex-1">
                <div className="text-sm font-medium">
                  Keep keyboard up after send
                </div>
                <div className="text-xs text-[color:var(--muted)]">
                  Refocus the input after sending. On iPhone this keeps the
                  on-screen keyboard from dismissing between messages.
                </div>
              </span>
              <span
                className={
                  'relative w-9 h-5 rounded-full transition-colors shrink-0 ' +
                  (keepFocus
                    ? 'bg-[color:var(--accent)]'
                    : 'bg-[color:var(--card)] border border-[color:var(--border)]')
                }
                aria-hidden="true"
              >
                <span
                  className={
                    'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ' +
                    (keepFocus ? 'translate-x-[18px]' : 'translate-x-0.5')
                  }
                />
              </span>
            </button>
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
      </aside>
    </>
  );
}
