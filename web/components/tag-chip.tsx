'use client';

// Tags get a stable colour from their own name, so the same tag reads the same
// on every screen without anyone having to choose a palette.
const HUES = [188, 262, 96, 32, 340, 210, 140, 12];

export function tagHue(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i += 1) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length];
}

export function TagChip({
  tag,
  active = false,
  count,
  onClick,
  onRemove,
  size = 'sm',
}: {
  tag: string;
  active?: boolean;
  count?: number;
  onClick?: () => void;
  onRemove?: () => void;
  size?: 'sm' | 'xs';
}) {
  const hue = tagHue(tag);
  const body = (
    <>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: `hsl(${hue} 55% 55%)` }}
      />
      <span className="truncate">{tag}</span>
      {count !== undefined && (
        <span className="text-[color:var(--muted)]">{count}</span>
      )}
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label={`remove ${tag}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              onRemove();
            }
          }}
          className="ml-0.5 cursor-pointer text-[color:var(--muted)] hover:text-[color:var(--fg)]"
        >
          ✕
        </span>
      )}
    </>
  );

  const className = `inline-flex items-center gap-1.5 rounded-full border ${
    size === 'xs' ? 'px-1.5 py-0 text-[10.5px]' : 'px-2 py-0.5 text-[11.5px]'
  } font-mono transition-colors`;
  const style = {
    borderColor: active ? `hsl(${hue} 45% 45%)` : 'var(--border)',
    background: active ? `hsl(${hue} 45% 45% / 0.16)` : 'transparent',
    color: active ? 'var(--fg)' : 'var(--muted)',
  };

  if (!onClick)
    return (
      <span className={className} style={style}>
        {body}
      </span>
    );

  return (
    <button type="button" onClick={onClick} className={className} style={style}>
      {body}
    </button>
  );
}
