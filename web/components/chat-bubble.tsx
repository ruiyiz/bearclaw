'use client';
import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
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
  ts: number;
  remoteId?: number;
  media?: BubbleMedia;
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

export interface BubbleProps {
  m: BubbleData;
  onRegenerate?: () => void;
  pinned?: boolean;
}

export function Bubble({ m, onRegenerate, pinned }: BubbleProps) {
  const own = m.side === 'user';
  const time = formatTimestamp(m.ts);
  return (
    <div
      className={'group flex flex-col ' + (own ? 'items-end' : 'items-start')}
    >
      <div
        className={
          'text-sm break-words ' +
          (own
            ? 'max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 bg-[color:var(--accent)] text-white'
            : 'w-full px-0 py-1')
        }
      >
        {m.media?.url && <MediaPreview media={m.media} />}
        {m.text ? (
          <MarkdownBody text={m.text} dark={own} />
        ) : m.media ? null : (
          <span>…</span>
        )}
      </div>
      {!own && m.text ? (
        <AssistantActions
          text={m.text}
          onRegenerate={onRegenerate}
          time={time}
          channelLabel={m.channelLabel}
          pinned={pinned}
        />
      ) : (
        (time || m.channelLabel) && (
          <span className="text-[10px] text-[color:var(--muted)] mt-0.5 px-1 flex gap-1.5 items-center opacity-0 group-hover:opacity-100 transition-opacity">
            {time && <span>{time}</span>}
            {m.channelLabel && (
              <span className="rounded-sm border border-[color:var(--border)] px-1 text-[9px] uppercase tracking-wide">
                {m.channelLabel}
              </span>
            )}
          </span>
        )
      )}
    </div>
  );
}

function AssistantActions({
  text,
  onRegenerate,
  time,
  channelLabel,
  pinned,
}: {
  text: string;
  onRegenerate?: () => void;
  time?: string;
  channelLabel?: string;
  pinned?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  }
  return (
    <div
      className={
        'mt-1 px-1 flex items-center gap-0.5 transition-opacity w-full ' +
        (pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')
      }
    >
      <button
        type="button"
        onClick={copy}
        title={copied ? 'Copied' : 'Copy message'}
        aria-label="Copy message"
        className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-[color:var(--card)]"
      >
        {copied ? (
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          title="Resend last message"
          aria-label="Resend last message"
          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-[color:var(--card)]"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      )}
      {(time || channelLabel) && (
        <span className="ml-auto text-[10px] text-[color:var(--muted)] flex gap-1.5 items-center">
          {time && <span>{time}</span>}
          {channelLabel && (
            <span className="rounded-sm border border-[color:var(--border)] px-1 text-[9px] uppercase tracking-wide">
              {channelLabel}
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

function CodeBlock({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const lang = (className || '').match(/language-(\S+)/)?.[1] || 'text';
  function copy() {
    const text = codeRef.current?.textContent || '';
    if (!text || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  }
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-current/10 text-xs">
      <div className="flex items-center justify-between px-3 py-1 bg-black/40 text-[10px] uppercase tracking-wide text-zinc-300">
        <span>{lang}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 hover:text-white transition-colors"
        >
          {copied ? (
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="overflow-x-auto">
        <code
          ref={codeRef}
          className={(className || '') + ' hljs block p-3'}
          {...props}
        >
          {children}
        </code>
      </pre>
    </div>
  );
}

export function MarkdownBody({ text, dark }: { text: string; dark: boolean }) {
  const inlineCodeBg = dark ? 'bg-white/20' : 'bg-black/10';
  return (
    <div
      className={
        'chat-md ' +
        (dark
          ? '[&_a]:text-white [&_a]:underline'
          : '[&_a]:text-[color:var(--accent)] [&_a]:underline')
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
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
            const isBlock = /(?:^|\s)(?:language-|hljs)/.test(className || '');
            if (isBlock) {
              return (
                <CodeBlock className={className} {...props}>
                  {children}
                </CodeBlock>
              );
            }
            return (
              <code
                className={
                  'rounded px-1 py-0.5 text-[0.85em] font-mono ' + inlineCodeBg
                }
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
            <h1 className="text-[1.2em] font-semibold mt-1 mb-1">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[1.1em] font-semibold mt-1 mb-1">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[1.05em] font-semibold mt-1 mb-1">
              {children}
            </h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-current/40 pl-2 italic opacity-90 my-1">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto -mx-1">
              <table className="min-w-full text-xs border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-current/30">{children}</thead>
          ),
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => (
            <tr className="border-b border-current/15 last:border-0">
              {children}
            </tr>
          ),
          th: ({ children, style }) => (
            <th
              className="px-2 py-1 text-left font-semibold whitespace-nowrap align-bottom"
              style={style}
            >
              {children}
            </th>
          ),
          td: ({ children, style }) => (
            <td className="px-2 py-1 align-top" style={style}>
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
