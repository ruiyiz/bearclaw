'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  api,
  type ChatSession,
  type ChatStreamEvent,
  type SlashCommand,
  type UserAgent,
} from '@/lib/api';

interface ChatMessage {
  id: string;
  side: 'user' | 'agent';
  text: string;
  // ms-epoch; 0 = unknown.
  ts: number;
  remoteId?: number;
  media?: { url: string; mediaType: string; caption?: string };
}

const TEXTAREA_MAX_PX = 240;

export function ChatView() {
  const [agents, setAgents] = useState<UserAgent[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [sending, setSending] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const pickerItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const latestSessionId = sessions[0]?.sessionId ?? null;
  const viewingLatest = sessionId !== null && sessionId === latestSessionId;

  useEffect(() => {
    api
      .userAgents()
      .then((d) => {
        setAgents(d.agents);
        if (d.agents.length > 0) {
          setFolder(
            d.agents.find((a) => a.folder === d.main)?.folder ||
              d.agents[0].folder,
          );
        }
      })
      .catch(() => {});
    api
      .commands()
      .then((d) => setCommands(d.commands))
      .catch(() => {});
  }, []);

  // Reload sessions whenever folder changes.
  useEffect(() => {
    if (!folder) {
      setSessions([]);
      setSessionId(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    api
      .chatSessions(folder)
      .then((d) => {
        if (cancelled) return;
        setSessions(d.sessions);
        setSessionId(d.sessions[0]?.sessionId ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setSessions([]);
        setSessionId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [folder]);

  // Load transcript when session changes.
  useEffect(() => {
    if (!folder || !sessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    api
      .chatHistory(folder, sessionId)
      .then((d) => {
        if (cancelled) return;
        setMessages(
          d.messages.map((m, i) => {
            const parsed = parseMediaTag(m.content, folder);
            return {
              id: `h-${sessionId}-${i}`,
              side: m.sender === 'Assistant' ? 'agent' : 'user',
              text: parsed?.text ?? m.content,
              ts: m.timestamp ? Date.parse(m.timestamp) || 0 : 0,
              media: parsed?.media,
            };
          }),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folder, sessionId]);

  useEffect(() => {
    if (!folder) return;
    sourceRef.current?.close();
    const es = new EventSource(
      `/api/user/chat/stream?folder=${encodeURIComponent(folder)}`,
    );
    sourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as ChatStreamEvent;
        applyStreamEvent(evt);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects.
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [messages, typing]);

  // Resize textarea to fit content, capped at TEXTAREA_MAX_PX.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, TEXTAREA_MAX_PX) + 'px';
  }, [input]);

  function applyStreamEvent(evt: ChatStreamEvent) {
    if (evt.type === 'typing') {
      // Only show typing for the live session view.
      if (viewingLatest) setTyping(evt.isTyping);
      return;
    }
    // Drop live events when scrolled back to an older session — they belong
    // to the latest session's transcript, not the one currently displayed.
    if (!viewingLatest) return;
    setTyping(false);
    setMessages((prev) => {
      switch (evt.type) {
        case 'message':
          return [
            ...prev,
            {
              id: `r-${evt.id}`,
              side: 'agent',
              text: evt.text,
              ts: evt.ts,
              remoteId: evt.id,
            },
          ];
        case 'edit':
          return prev.map((m) =>
            m.remoteId === evt.id ? { ...m, text: evt.text, ts: evt.ts } : m,
          );
        case 'delete':
          return prev.filter((m) => m.remoteId !== evt.id);
        case 'media':
          return [
            ...prev,
            {
              id: `r-${evt.id}`,
              side: 'agent',
              text: evt.caption ?? '',
              ts: evt.ts,
              remoteId: evt.id,
              media: evt.url
                ? {
                    url: evt.url,
                    mediaType: evt.mediaType,
                    caption: evt.caption,
                  }
                : undefined,
            },
          ];
        default:
          return prev;
      }
    });
  }

  function kindForMime(mime: string): 'image' | 'video' | 'audio' | 'document' {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
  }

  async function fileToBase64(file: Blob): Promise<string> {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      bin += String.fromCharCode(
        ...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)),
      );
    }
    return btoa(bin);
  }

  async function handleFile(file: File) {
    if (!folder || uploading) return;
    if (!viewingLatest && latestSessionId) setSessionId(latestSessionId);
    setUploading(true);
    const kind = kindForMime(file.type || '');
    const previewUrl = URL.createObjectURL(file);
    const localId = `u-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: localId,
        side: 'user',
        text: '',
        ts: Date.now(),
        media: {
          url: previewUrl,
          mediaType: kind,
          caption: file.name,
        },
      },
    ]);
    try {
      const dataB64 = await fileToBase64(file);
      await api.chatUpload({
        folder,
        kind,
        fileName: file.name,
        mimeType: file.type,
        dataB64,
      });
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          side: 'agent',
          text: `(upload failed: ${String(e)})`,
          ts: Date.now(),
        },
      ]);
    } finally {
      setUploading(false);
    }
  }

  async function startRecording() {
    if (!folder || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      recordedChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunksRef.current, { type: mime });
        recordedChunksRef.current = [];
        if (blob.size === 0) return;
        if (!viewingLatest && latestSessionId) setSessionId(latestSessionId);
        const localId = `v-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: localId,
            side: 'user',
            text: '[Voice message] (uploading…)',
            ts: Date.now(),
          },
        ]);
        setUploading(true);
        try {
          const dataB64 = await fileToBase64(blob);
          const res = await api.chatUpload({
            folder: folder!,
            kind: 'voice',
            fileName: `voice.${mime.includes('webm') ? 'webm' : 'm4a'}`,
            mimeType: mime,
            dataB64,
          });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === localId
                ? {
                    ...m,
                    text: res.transcript
                      ? `[Voice message] ${res.transcript}`
                      : '[Voice message]',
                  }
                : m,
            ),
          );
        } catch (e) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === localId
                ? { ...m, text: `(voice upload failed: ${String(e)})` }
                : m,
            ),
          );
        } finally {
          setUploading(false);
        }
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          side: 'agent',
          text: `(mic failed: ${String(err)})`,
          ts: Date.now(),
        },
      ]);
    }
  }

  function stopRecording() {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    if (rec.state !== 'inactive') rec.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }

  async function send() {
    if (!folder || !input.trim() || sending) return;
    if (!viewingLatest) {
      // Sending always lands in the agent's live (latest) session — jump
      // forward so the user sees their bubble in the right view.
      if (latestSessionId) setSessionId(latestSessionId);
    }
    const text = input.trim();
    setInput('');
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, side: 'user', text, ts: Date.now() },
    ]);
    try {
      await api.chat(folder, text);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          side: 'agent',
          text: `(send failed: ${String(e)})`,
          ts: Date.now(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  const sessionLabels = useMemo(() => {
    return sessions.map((s) => ({
      value: s.sessionId,
      label: formatSessionLabel(s),
    }));
  }, [sessions]);

  // Slash-command picker: active only when input starts with `/` and the user
  // is still typing the command token (no whitespace yet).
  const slashMatch = useMemo(() => {
    if (!input.startsWith('/')) return null;
    const token = input.slice(1);
    if (/\s/.test(token)) return null;
    return token.toLowerCase();
  }, [input]);

  const pickerOptions = useMemo(() => {
    if (slashMatch === null) return [];
    return commands.filter((c) => c.name.toLowerCase().startsWith(slashMatch));
  }, [commands, slashMatch]);

  const pickerVisible = pickerOptions.length > 0;

  useEffect(() => {
    setPickerIndex(0);
  }, [slashMatch]);

  useEffect(() => {
    const el = pickerItemRefs.current[pickerIndex];
    el?.scrollIntoView({ block: 'nearest' });
  }, [pickerIndex]);

  function applyCommand(name: string) {
    setInput(`/${name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-[color:var(--border)] px-3 py-2 flex flex-wrap items-center gap-2">
        <label className="text-xs text-[color:var(--muted)]">Agent</label>
        <select
          value={folder ?? ''}
          onChange={(e) => setFolder(e.target.value || null)}
          className="bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-2 py-1 text-sm"
        >
          {agents.map((a) => (
            <option key={a.folder} value={a.folder}>
              {a.name} ({a.folder})
            </option>
          ))}
        </select>
        <label className="text-xs text-[color:var(--muted)] ml-2">
          Session
        </label>
        <select
          value={sessionId ?? ''}
          onChange={(e) => setSessionId(e.target.value || null)}
          disabled={sessions.length === 0}
          className="bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-2 py-1 text-sm max-w-[60vw] disabled:opacity-50"
        >
          {sessionLabels.length === 0 && <option value="">(none)</option>}
          {sessionLabels.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {!viewingLatest && sessionId && (
          <button
            type="button"
            onClick={() => latestSessionId && setSessionId(latestSessionId)}
            className="text-xs text-[color:var(--accent)] underline"
          >
            jump to latest
          </button>
        )}
        {typing && (
          <span className="text-xs text-[color:var(--muted)]">… typing</span>
        )}
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
      >
        {loadingHistory && (
          <div className="text-center text-xs text-[color:var(--muted)]">
            loading transcript…
          </div>
        )}
        {!loadingHistory && messages.length === 0 && (
          <div className="h-full flex items-center justify-center text-center px-6">
            <div className="text-[color:var(--muted)] text-sm">
              {folder ? (
                <>
                  Chatting with <span className="font-medium">{folder}</span>.
                  <br />
                  Type a message below to start.
                </>
              ) : (
                'Pick an agent above.'
              )}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        {typing && messages.length > 0 && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-[color:var(--card)] border border-[color:var(--border)] px-3 py-2 text-sm text-[color:var(--muted)]">
              …
            </div>
          </div>
        )}
      </div>
      <form
        className="border-t border-[color:var(--border)] p-2 flex gap-2 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*,application/pdf,.zip,.txt,.md,.csv,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          aria-label="Attach"
          disabled={!folder || uploading || recording}
          onClick={() => fileInputRef.current?.click()}
          className="h-9 inline-flex items-center justify-center rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 text-sm leading-none disabled:opacity-40"
          title="Attach file"
        >
          📎
        </button>
        <button
          type="button"
          aria-label={recording ? 'Stop recording' : 'Record voice'}
          disabled={!folder || uploading}
          onClick={() => (recording ? stopRecording() : void startRecording())}
          className={
            'h-9 inline-flex items-center justify-center rounded-md border px-3 text-sm leading-none disabled:opacity-40 ' +
            (recording
              ? 'border-red-500 bg-red-500/20 text-red-300 animate-pulse'
              : 'border-[color:var(--border)] bg-[color:var(--card)]')
          }
          title={recording ? 'Stop recording' : 'Record voice message'}
        >
          {recording ? '⏹' : '🎙'}
        </button>
        <div className="relative flex-1">
          {pickerVisible && (
            <div className="absolute bottom-full left-0 right-0 mb-1 max-h-60 overflow-y-auto rounded-md border border-[color:var(--border)] bg-[color:var(--card)] shadow-lg z-10">
              {pickerOptions.map((c, i) => (
                <button
                  type="button"
                  key={c.name}
                  ref={(el) => {
                    pickerItemRefs.current[i] = el;
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyCommand(c.name);
                  }}
                  onMouseEnter={() => setPickerIndex(i)}
                  className={
                    'w-full text-left px-3 py-1.5 text-sm flex gap-3 items-baseline ' +
                    (i === pickerIndex
                      ? 'bg-[color:var(--accent)]/20'
                      : 'hover:bg-white/5')
                  }
                >
                  <span className="font-mono">/{c.name}</span>
                  <span className="text-xs text-[color:var(--muted)] truncate">
                    {c.description}
                  </span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (pickerVisible) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setPickerIndex((i) => (i + 1) % pickerOptions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setPickerIndex(
                    (i) =>
                      (i - 1 + pickerOptions.length) % pickerOptions.length,
                  );
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  const pick = pickerOptions[pickerIndex];
                  if (pick) applyCommand(pick.name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setInput('');
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={folder ? `Message ${folder}…` : 'Pick an agent'}
            className="w-full block min-h-9 resize-none overflow-y-auto bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[color:var(--accent)] leading-5 align-bottom"
          />
        </div>
        <button
          type="submit"
          disabled={!folder || !input.trim() || sending}
          className="h-9 inline-flex items-center justify-center rounded-md bg-[color:var(--accent)] text-white px-4 text-sm leading-none disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

const MEDIA_TAG_RE = /^\[(Photo|Video|Audio|Document):\s+([^\]]+?)\](.*)$/s;

function parseMediaTag(
  content: string,
  folder: string,
): {
  text: string;
  media: { url: string; mediaType: string; caption?: string };
} | null {
  const m = content.match(MEDIA_TAG_RE);
  if (!m) return null;
  const tag = m[1];
  const raw = m[2].trim();
  const trailing = m[3].trim();
  // [Document: name.pdf] without a path on disk: skip — can't fetch.
  if (!raw.startsWith('/')) return null;
  const kindMap: Record<string, string> = {
    Photo: 'image',
    Video: 'video',
    Audio: 'audio',
    Document: 'document',
  };
  const mediaType = kindMap[tag];
  return {
    text: trailing,
    media: {
      url: api.agentMediaUrl(folder, raw),
      mediaType,
      caption: trailing || undefined,
    },
  };
}

function formatSessionLabel(s: ChatSession): string {
  const when = new Date(s.lastModified).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const title = (s.summary || s.firstPrompt || s.sessionId.slice(0, 8)).trim();
  const short = title.length > 60 ? title.slice(0, 57) + '…' : title;
  return `${when} — ${short}`;
}

function formatTimestamp(ts: number): string {
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

function Bubble({ m }: { m: ChatMessage }) {
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
      {time && (
        <span className="text-[10px] text-[color:var(--muted)] mt-0.5 px-1">
          {time}
        </span>
      )}
    </div>
  );
}

function MediaPreview({
  media,
}: {
  media: { url: string; mediaType: string; caption?: string };
}) {
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
  // document / other
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

function MarkdownBody({ text, dark }: { text: string; dark: boolean }) {
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
