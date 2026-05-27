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
  {
    id: 'source-serif',
    label: 'Source Serif',
    description: 'Editorial serif, Claude-style',
  },
  {
    id: 'lora',
    label: 'Lora',
    description: 'Warm contemporary serif',
  },
];

export const FONT_STORAGE_KEY = 'nc.font';
export const FONT_DEFAULT = 'geist';

const FONT_STACK_SUFFIX =
  ", ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Font choice applies to chat message text only — the UI font is fixed.
// `.chat-md` consumes `--chat-font` via globals.css. Set on body because the
// next/font `--font-*` CSS variables that we delegate to are scoped to body
// (defined by the next/font className applied to <body>).
export function applyFont(id: string): void {
  if (typeof document === 'undefined') return;
  const body = document.body;
  if (!body) return;
  body.style.setProperty(
    '--chat-font',
    `var(--font-${id})${FONT_STACK_SUFFIX}`,
  );
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

export type FontSize = 'sm' | 'md' | 'lg' | 'xl';

export interface FontSizeOption {
  id: FontSize;
  label: string;
  px: number;
}

export const FONT_SIZE_OPTIONS: FontSizeOption[] = [
  { id: 'sm', label: 'Small', px: 13 },
  { id: 'md', label: 'Medium', px: 14 },
  { id: 'lg', label: 'Large', px: 16 },
  { id: 'xl', label: 'Extra Large', px: 18 },
];

export const FONT_SIZE_STORAGE_KEY = 'nc.fontSize';
export const FONT_SIZE_DEFAULT: FontSize = 'md';

// Font size applies to chat message text only (consumed by `.chat-md`).
export function applyFontSize(id: FontSize): void {
  if (typeof document === 'undefined') return;
  const opt = FONT_SIZE_OPTIONS.find((o) => o.id === id);
  if (!opt) return;
  const body = document.body;
  if (!body) return;
  body.style.setProperty('--chat-font-size', `${opt.px}px`);
}

export function loadFontSize(): FontSize {
  if (typeof window === 'undefined') return FONT_SIZE_DEFAULT;
  try {
    const v = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    if (v === 'sm' || v === 'md' || v === 'lg' || v === 'xl') return v;
    return FONT_SIZE_DEFAULT;
  } catch {
    return FONT_SIZE_DEFAULT;
  }
}

export function saveFontSize(id: FontSize): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
