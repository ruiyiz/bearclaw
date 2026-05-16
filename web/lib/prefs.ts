// User preferences stored client-side in localStorage. Keep this file
// dependency-free so it can be imported from layout bootstrap scripts and
// React components alike.

export const KEEP_FOCUS_STORAGE_KEY = 'nc.keepFocusOnSend';
export const KEEP_FOCUS_DEFAULT = true;

export function loadKeepFocusOnSend(): boolean {
  if (typeof window === 'undefined') return KEEP_FOCUS_DEFAULT;
  try {
    const v = window.localStorage.getItem(KEEP_FOCUS_STORAGE_KEY);
    if (v === null) return KEEP_FOCUS_DEFAULT;
    return v === '1';
  } catch {
    return KEEP_FOCUS_DEFAULT;
  }
}

export function saveKeepFocusOnSend(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEEP_FOCUS_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
