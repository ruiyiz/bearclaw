export interface FontOption {
  id: string;
  label: string;
  description: string;
}

export const FONT_OPTIONS: FontOption[] = [
  { id: 'geist', label: 'Geist', description: 'Modern, neutral sans' },
  {
    id: 'space',
    label: 'Space Grotesk',
    description: 'Geometric sans with character',
  },
  { id: 'inter', label: 'Inter', description: 'Classic UI sans' },
  { id: 'manrope', label: 'Manrope', description: 'Friendly rounded sans' },
  {
    id: 'plex',
    label: 'IBM Plex Sans',
    description: 'Editorial / technical sans',
  },
];

export const FONT_STORAGE_KEY = 'nc.font';
export const FONT_DEFAULT = 'geist';

export function applyFont(id: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--app-font', `var(--font-${id})`);
}

export function loadFont(): string {
  if (typeof window === 'undefined') return FONT_DEFAULT;
  try {
    return window.localStorage.getItem(FONT_STORAGE_KEY) || FONT_DEFAULT;
  } catch {
    return FONT_DEFAULT;
  }
}

export function saveFont(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
