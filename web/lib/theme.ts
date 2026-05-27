export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_KEY = 'nc.theme';
export const THEME_DEFAULT: ThemeMode = 'system';

export const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (mode === 'system') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', mode);
}

export function loadTheme(): ThemeMode {
  if (typeof window === 'undefined') return THEME_DEFAULT;
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system'
      ? (v as ThemeMode)
      : THEME_DEFAULT;
  } catch {
    return THEME_DEFAULT;
  }
}

export function saveTheme(mode: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* ignore */
  }
}
