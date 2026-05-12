import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@/lib/api';

export interface BubbleMedia {
  url: string;
  mediaType: string;
  caption?: string;
}

export interface BubbleData {
  id: string;
  side: 'user' | 'agent';
  text: string;
  // ms-epoch; 0 = unknown.
  ts: number;
  remoteId?: number;
  media?: BubbleMedia;
  // Short label shown next to the timestamp (e.g. "telegram", "imessage").
  // Set when rendering cross-channel views so the user knows where each
  // message came from.
  channelLabel?: string;
}

export function channelLabelFromJid(jid: string): string {
  if (jid.startsWith('web:')) return 'web';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('imsg:')) return 'imessage';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us'))
    return 'whatsapp';
  return jid.split(':')[0] || 'unknown';
}

const MEDIA_TAG_RE = /^\[(Photo|Video|Audio|Document):\s+([^\]]+?)\](.*)$/s;

// Parse a Telegram-style `[Photo: /abs/path]{ caption}` tag out of stored
// message content so historical media bubbles can be re-rendered. Returns
// `null` when no on-disk media path is referenced.
export function parseMediaTag(
  content: string,
  folder: string,
): { text: string; media: BubbleMedia } | null {
  const m = content.match(MEDIA_TAG_RE);
  if (!m) return null;
  const tag = m[1];
  const raw = m[2].trim();
  const trailing = m[3].trim();
  if (!raw.startsWith('/')) return null;
  const kindMap: Record<string, string> = {
    Photo: 'image',
    Video: 'video',
    Audio: 'audio',
    Document: 'document',
  };
  return {
    text: trailing,
    media: {
      url: api.agentMediaUrl(folder, raw),
      mediaType: kindMap[tag],
      caption: trailing || undefined,
    },
  };
}

export function formatTimestamp(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return d.toLocaleString(undefined, {
    month: sameDay ? undefined : 'short',
    day: sameDay ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function Bubble({ m }: { m: BubbleData }) {
  const own = m.side === 'user';
  const time = formatTimestamp(m.ts);
  return (
    <div className={'flex flex-col ' + (own ? 'items-end' : 'items-start')}>
      <div
        className={
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words ' +
          (own
            ? 'bg-[color:var(--accent)] text-white rounded-br-md'
            : 'bg-[color:var(--card)] border border-[color:var(--border)] rounded-bl-md')
        }
      >
        {m.media?.url && <MediaPreview media={m.media} />}
        {m.text ? (
          <MarkdownBody text={m.text} dark={own} />
        ) : m.media ? null : (
          <span>…</span>
        )}
      </div>
      {(time || m.channelLabel) && (
        <span className="text-[10px] text-[color:var(--muted)] mt-0.5 px-1 flex gap-1.5 items-center">
          {time && <span>{time}</span>}
          {m.channelLabel && (
            <span className="rounded-sm border border-[color:var(--border)] px-1 text-[9px] uppercase tracking-wide">
              {m.channelLabel}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function MediaPreview({ media }: { media: BubbleMedia }) {
  const t = media.mediaType.toLowerCase();
  if (t === 'image' || t.startsWith('image/')) {
    return (
      <img
        src={media.url}
        alt={media.caption || ''}
        className="rounded-md mb-1 max-h-80 object-contain"
      />
    );
  }
  if (t === 'video' || t.startsWith('video/')) {
    return (
      <video
        src={media.url}
        controls
        className="rounded-md mb-1 max-h-80 w-full"
      />
    );
  }
  if (t === 'audio' || t.startsWith('audio/')) {
    return <audio src={media.url} controls className="mb-1 w-full" />;
  }
  const filename = media.url.split('/').pop() || 'file';
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 underline mb-1"
      download
    >
      📎 {decodeURIComponent(filename)}
    </a>
  );
}

export function MarkdownBody({ text, dark }: { text: string; dark: boolean }) {
  return (
    <div
      className={
        'chat-md ' +
        (dark
          ? '[&_a]:text-white [&_a]:underline [&_code]:bg-white/20'
          : '[&_a]:text-[color:var(--accent)] [&_a]:underline [&_code]:bg-black/10')
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="whitespace-pre-wrap [&:not(:last-child)]:mb-2">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 [&:not(:last-child)]:mb-2">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 [&:not(:last-child)]:mb-2">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className || '');
            if (isBlock) {
              return (
                <pre className="bg-black/30 rounded-md p-2 my-2 overflow-x-auto text-xs">
                  <code {...props}>{children}</code>
                </pre>
              );
            }
            return (
              <code
                className="rounded px-1 py-0.5 text-[0.85em] font-mono"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h1 className="text-base font-semibold mt-1 mb-1">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-semibold mt-1 mb-1">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold mt-1 mb-1">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-current/40 pl-2 italic opacity-90 my-1">
              {children}
            </blockquote>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
