'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ChatSession,
  type ChatStreamEvent,
  type UserAgent,
} from '@/lib/api';

interface ChatMessage {
  id: string;
  side: 'user' | 'agent';
  text: string;
  remoteId?: number;
  media?: { url: string; mediaType: string; caption?: string };
}

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
          d.messages.map((m, i) => ({
            id: `h-${sessionId}-${i}`,
            side: m.sender === 'Assistant' ? 'agent' : 'user',
            text: m.content,
          })),
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
              remoteId: evt.id,
            },
          ];
        case 'edit':
          return prev.map((m) =>
            m.remoteId === evt.id ? { ...m, text: evt.text } : m,
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
      { id: `u-${Date.now()}`, side: 'user', text },
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
        className="border-t border-[color:var(--border)] p-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={folder ? `Message ${folder}…` : 'Pick an agent'}
          className="flex-1 resize-none bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[color:var(--accent)]"
        />
        <button
          type="submit"
          disabled={!folder || !input.trim() || sending}
          className="rounded-md bg-[color:var(--accent)] text-white px-4 py-2 text-sm disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
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

function Bubble({ m }: { m: ChatMessage }) {
  const own = m.side === 'user';
  return (
    <div className={'flex ' + (own ? 'justify-end' : 'justify-start')}>
      <div
        className={
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ' +
          (own
            ? 'bg-[color:var(--accent)] text-white rounded-br-md'
            : 'bg-[color:var(--card)] border border-[color:var(--border)] rounded-bl-md')
        }
      >
        {m.media?.url && m.media.mediaType.startsWith('image') && (
          <img
            src={m.media.url}
            alt={m.media.caption || ''}
            className="rounded-md mb-1 max-h-80 object-contain"
          />
        )}
        {m.text || (m.media ? '' : '…')}
      </div>
    </div>
  );
}
