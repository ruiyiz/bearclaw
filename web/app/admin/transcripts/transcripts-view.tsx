'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type TranscriptMessage,
  type TranscriptSession,
  type UserAgent,
} from '@/lib/api';
import {
  Bubble,
  parseMediaTag,
  type BubbleData,
} from '@/components/chat-bubble';

function rowToBubble(
  m: TranscriptMessage,
  folder: string,
  idx: number,
  sessionId: string,
): BubbleData {
  const parsed = parseMediaTag(m.content, folder);
  return {
    id: `t-${sessionId}-${idx}`,
    side: m.sender === 'Assistant' ? 'agent' : 'user',
    text: parsed?.text ?? m.content,
    ts: m.timestamp ? Date.parse(m.timestamp) || 0 : 0,
    media: parsed?.media,
  };
}

function formatSessionLabel(s: TranscriptSession): string {
  const when = new Date(s.lastModified).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const title = (s.summary || s.firstPrompt || s.sessionId.slice(0, 8)).trim();
  const short = title.length > 80 ? title.slice(0, 77) + '…' : title;
  return `${when} — ${short}`;
}

export function TranscriptsView() {
  const [agents, setAgents] = useState<UserAgent[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [sessions, setSessions] = useState<TranscriptSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    setLoadingSessions(true);
    setError(null);
    api
      .transcriptSessions(folder)
      .then((d) => {
        if (cancelled) return;
        setSessions(d.sessions);
        setSessionId(d.sessions[0]?.sessionId ?? null);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingSessions(false));
    return () => {
      cancelled = true;
    };
  }, [folder]);

  useEffect(() => {
    if (!folder || !sessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingTranscript(true);
    api
      .transcriptMessages(folder, sessionId)
      .then((d) => {
        if (!cancelled) setMessages(d.messages);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingTranscript(false));
    return () => {
      cancelled = true;
    };
  }, [folder, sessionId]);

  const bubbles = useMemo(() => {
    if (!folder || !sessionId) return [];
    return messages.map((m, i) => rowToBubble(m, folder, i, sessionId));
  }, [messages, folder, sessionId]);

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex flex-wrap items-center gap-2">
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
        <span className="text-xs text-[color:var(--muted)] ml-2">
          read-only SDK session viewer
        </span>
      </div>

      {error && (
        <div className="text-xs text-red-400 border border-red-500/40 rounded-md px-2 py-1">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-3 flex-1 min-h-0">
        <div className="border border-[color:var(--border)] rounded-md overflow-y-auto">
          {loadingSessions && (
            <div className="p-2 text-xs text-[color:var(--muted)]">
              loading…
            </div>
          )}
          {!loadingSessions && sessions.length === 0 && (
            <div className="p-2 text-xs text-[color:var(--muted)]">
              no sessions
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => setSessionId(s.sessionId)}
              className={
                'w-full text-left px-2 py-1.5 text-xs border-b border-[color:var(--border)] last:border-b-0 ' +
                (s.sessionId === sessionId
                  ? 'bg-[color:var(--accent)]/20'
                  : 'hover:bg-white/5')
              }
              title={s.sessionId}
            >
              {formatSessionLabel(s)}
            </button>
          ))}
        </div>

        <div className="border border-[color:var(--border)] rounded-md p-3 overflow-y-auto space-y-2">
          {loadingTranscript && (
            <div className="text-xs text-[color:var(--muted)]">
              loading transcript…
            </div>
          )}
          {!loadingTranscript && bubbles.length === 0 && (
            <div className="text-xs text-[color:var(--muted)]">
              pick a session on the left
            </div>
          )}
          {bubbles.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
        </div>
      </div>
    </div>
  );
}
