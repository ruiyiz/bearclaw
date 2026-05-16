'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ChatMessage,
  type ChatStreamEvent,
  type SlashCommand,
  type UserAgent,
  type WebSession,
} from '@/lib/api';
import {
  Bubble,
  parseMediaTag,
  type BubbleData,
} from '@/components/chat-bubble';
import { SettingsModal } from '@/components/settings-modal';
import { loadKeepFocusOnSend } from '@/lib/prefs';

const TEXTAREA_MAX_PX = 240;
const HISTORY_LIMIT = 200;
const COLLAPSED_KEY = 'nc.chat.collapsedAgents';

function rowToBubble(m: ChatMessage, folder: string): BubbleData {
  const parsed = parseMediaTag(m.content, folder);
  return {
    id: `db-${m.id}`,
    side: m.isFromMe ? 'agent' : 'user',
    text: parsed?.text ?? m.content,
    ts: m.timestamp ? Date.parse(m.timestamp) || 0 : 0,
    media: parsed?.media,
  };
}

function avatarColor(folder: string): string {
  // Stable hue from folder name. Used for the round agent badge.
  let h = 0;
  for (const c of folder) h = (h * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function shortWhen(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMin = (Date.now() - then) / 60000;
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${Math.floor(diffMin)}m`;
  if (diffMin < 24 * 60) return `${Math.floor(diffMin / 60)}h`;
  return `${Math.floor(diffMin / (60 * 24))}d`;
}

function loadCollapsed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(
      Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function saveCollapsed(s: Set<string>): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]));
}

function urlState(): { folder: string | null; session: string | null } {
  if (typeof window === 'undefined') return { folder: null, session: null };
  const sp = new URLSearchParams(window.location.search);
  return {
    folder: sp.get('folder'),
    session: sp.get('session'),
  };
}

function pushUrl(folder: string, session: string): void {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams(window.location.search);
  sp.set('folder', folder);
  sp.set('session', session);
  const next = `${window.location.pathname}?${sp.toString()}`;
  window.history.replaceState({}, '', next);
}

// Ease-out cubic rAF scroll animation. Replaces scrollTo({behavior:'smooth'})
// because iOS Safari ignores it on overflow containers when momentum scroll
// or a layout shift is in flight.
function animateScrollTop(
  el: HTMLElement,
  target: number,
  duration = 250,
): void {
  const start = el.scrollTop;
  const delta = target - start;
  if (Math.abs(delta) < 1) {
    el.scrollTop = target;
    return;
  }
  const startTs = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - startTs) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.scrollTop = start + delta * eased;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function ChatView() {
  const [agents, setAgents] = useState<UserAgent[]>([]);
  const [sessionsByFolder, setSessionsByFolder] = useState<
    Record<string, WebSession[]>
  >({});
  const [folder, setFolder] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    loadCollapsed(),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [messages, setMessages] = useState<BubbleData[]>([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
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
  const justLoadedRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const bottomSpacerRef = useRef<HTMLDivElement | null>(null);

  const refreshSessions = useCallback(
    async (f: string): Promise<WebSession[]> => {
      const d = await api.chatSessions(f);
      setSessionsByFolder((prev) => ({ ...prev, [f]: d.sessions }));
      return d.sessions;
    },
    [],
  );

  // Boot: load agents, snap to URL state if any, otherwise default to the main
  // folder + its most-recent session (or auto-create one).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agentsD, cmdsD] = await Promise.all([
          api.userAgents(),
          api.commands().catch(() => ({ commands: [] as SlashCommand[] })),
        ]);
        if (cancelled) return;
        setAgents(agentsD.agents);
        setCommands(cmdsD.commands);

        // Prefetch sessions for every agent so the sidebar renders fully on
        // first paint. Cheap (one row per session per folder).
        const sessionEntries = await Promise.all(
          agentsD.agents.map(async (a) => {
            try {
              const d = await api.chatSessions(a.folder);
              return [a.folder, d.sessions] as const;
            } catch {
              return [a.folder, [] as WebSession[]] as const;
            }
          }),
        );
        if (cancelled) return;
        const byFolder: Record<string, WebSession[]> = {};
        for (const [k, v] of sessionEntries) byFolder[k] = v;
        setSessionsByFolder(byFolder);

        const wanted = urlState();
        const initialFolder =
          wanted.folder ||
          agentsD.agents.find((a) => a.folder === agentsD.main)?.folder ||
          agentsD.agents[0]?.folder ||
          null;
        if (!initialFolder) return;

        let initialSession = wanted.session;
        if (!initialSession) {
          const list = byFolder[initialFolder] || [];
          initialSession = list[0]?.id || null;
          if (!initialSession) {
            // Bootstrap an empty session so the composer has somewhere to
            // write. New users land on a fresh thread.
            const created = await api.createChatSession(initialFolder);
            if (cancelled) return;
            initialSession = created.id;
            setSessionsByFolder((prev) => ({
              ...prev,
              [initialFolder]: [
                {
                  id: created.id,
                  folder: created.folder,
                  title: created.title,
                  sdkSessionId: null,
                  createdAt: new Date().toISOString(),
                  lastMessageAt: null,
                  pinned: false,
                  archived: false,
                },
                ...(prev[initialFolder] || []),
              ],
            }));
          }
        }
        setFolder(initialFolder);
        setSessionId(initialSession);
        pushUrl(initialFolder, initialSession);
      } catch {
        /* unauthed redirects via api helpers */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // History reload when folder/session changes, plus a refetch on tab
  // foreground so we catch anything the broker fanned out during a blackout.
  const reloadHistory = useCallback(
    (f: string, s: string, opts: { showSpinner: boolean }) => {
      let cancelled = false;
      if (opts.showSpinner) setLoadingHistory(true);
      api
        .chatMessages(f, s, { limit: HISTORY_LIMIT })
        .then((d) => {
          if (cancelled) return;
          const rows = [...d.messages].reverse();
          setMessages(rows.map((m) => rowToBubble(m, f)));
        })
        .catch(() => {
          if (cancelled) return;
          if (opts.showSpinner) setMessages([]);
        })
        .finally(() => {
          if (!cancelled && opts.showSpinner) setLoadingHistory(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [],
  );

  useEffect(() => {
    if (!folder || !sessionId) {
      setMessages([]);
      return;
    }
    justLoadedRef.current = true;
    const cancel = reloadHistory(folder, sessionId, { showSpinner: true });
    return cancel;
  }, [folder, sessionId, reloadHistory]);

  // SSE stream keyed to the active composite jid. Browser auto-reconnect goes
  // through a Next.js prod proxy and sometimes never re-establishes a fresh
  // backend subscription after the backend restarts (zero broker listeners on
  // the new process). We force a fresh EventSource on every error / hidden →
  // visible transition / focus / pageshow, and refetch history on reopen so
  // anything fanned out during the blackout still surfaces.
  useEffect(() => {
    if (!folder || !sessionId) return;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      if (closed) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      sourceRef.current?.close();
      const ssePath = `/api/user/chat/stream?folder=${encodeURIComponent(folder)}&sessionId=${encodeURIComponent(sessionId)}`;
      const es = new EventSource(ssePath);
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
        // Browser auto-reconnect can wedge behind some prod proxies; tear
        // the socket down and retry ourselves. The history refetch on
        // reopen catches anything fanned out during the blackout.
        es.close();
        if (closed) return;
        retryTimer = setTimeout(() => {
          if (!closed) {
            reloadHistory(folder, sessionId, { showSpinner: false });
            open();
          }
        }, 1500);
      };
    };

    open();

    const reopen = () => {
      if (closed) return;
      reloadHistory(folder, sessionId, { showSpinner: false });
      const es = sourceRef.current;
      if (!es || es.readyState !== EventSource.OPEN) open();
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') reopen();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', reopen);
    window.addEventListener('focus', reopen);
    window.addEventListener('online', reopen);

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', reopen);
      window.removeEventListener('focus', reopen);
      window.removeEventListener('online', reopen);
      sourceRef.current?.close();
    };
  }, [folder, sessionId, reloadHistory]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    // Keep the trailing spacer at least as tall as the scroll viewport so
    // the latest bubble can always reach the top of the viewport. A
    // CSS-only `min-h-[60dvh]` measures the page viewport, which can be
    // smaller than the scroll container's actual height — when that
    // happens the browser clamps scrollTop and the pin falls short.
    if (bottomSpacerRef.current) {
      bottomSpacerRef.current.style.minHeight = `${el.clientHeight}px`;
    }

    // node.offsetTop measures from the nearest positioned ancestor, which
    // in this layout is the grid wrapper above the chat header — not the
    // scroll container. Use getBoundingClientRect deltas so we always
    // resolve a position relative to the scroll viewport.
    const relativeTop = (node: HTMLElement): number =>
      node.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop;

    if (justLoadedRef.current) {
      justLoadedRef.current = false;
      if (messages.length > 0) {
        const lastId = messages[messages.length - 1].id;
        const node = el.querySelector<HTMLElement>(
          `[data-msg-id="${CSS.escape(lastId)}"]`,
        );
        if (node) {
          el.scrollTop = Math.max(
            0,
            relativeTop(node) + node.offsetHeight - el.clientHeight,
          );
          return;
        }
      }
      el.scrollTop = el.scrollHeight;
      return;
    }

    // New user message appended: pin it to the top, ChatGPT-style. The
    // agent's reply bubble appears below and streams in without moving
    // the viewport — if we pinned every append, the agent's first chunk
    // would yank the user's own message off-screen.
    if (messages.length > prev) {
      const last = messages[messages.length - 1];
      if (last.side === 'user') {
        // Defer one frame so the new bubble + resized spacer are laid out
        // before we measure, then animate manually. iOS Safari does not
        // reliably honour scrollTo({behavior:'smooth'}) on overflow
        // containers — momentum scroll cancels it, or it silently no-ops.
        requestAnimationFrame(() => {
          const node = el.querySelector<HTMLElement>(
            `[data-msg-id="${CSS.escape(last.id)}"]`,
          );
          if (!node) return;
          const target = Math.max(0, relativeTop(node) - 8);
          animateScrollTop(el, target, 280);
        });
      }
    }
  }, [messages]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [folder, sessionId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const ta = textareaRef.current;
      if (!ta || document.activeElement === ta) return;
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        tag === 'BUTTON' ||
        tgt?.isContentEditable
      )
        return;
      e.preventDefault();
      ta.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, TEXTAREA_MAX_PX) + 'px';
  }, [input]);

  function applyStreamEvent(evt: ChatStreamEvent) {
    if (evt.type === 'typing') {
      setTyping(evt.isTyping);
      return;
    }
    if (evt.type === 'activity') {
      setActivity(evt.label);
      return;
    }
    setTyping(false);
    if (evt.type === 'edit' || evt.type === 'message' || evt.type === 'media') {
      setActivity(null);
    }
    setMessages((prev) => {
      switch (evt.type) {
        case 'message':
          if (prev.some((m) => m.remoteId === evt.id)) return prev;
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
          if (prev.some((m) => m.remoteId === evt.id)) return prev;
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
    if (!folder || !sessionId || uploading) return;
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
        media: { url: previewUrl, mediaType: kind, caption: file.name },
      },
    ]);
    try {
      const dataB64 = await fileToBase64(file);
      await api.chatUpload({
        folder,
        sessionId,
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
    if (!folder || !sessionId || recording) return;
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
            sessionId: sessionId!,
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
    if (!folder || !sessionId || !input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    // Restore textarea focus inside the same user-gesture tick. Tapping
    // the Send button transfers focus to the button; on iOS that also
    // dismisses the virtual keyboard. Refocusing synchronously keeps the
    // composer hot for the next message. (When Enter submits, the
    // textarea already has focus and this is a no-op.) Gated by the
    // user-preference toggle in Settings.
    if (loadKeepFocusOnSend()) textareaRef.current?.focus();
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, side: 'user', text, ts: Date.now() },
    ]);
    try {
      await api.chat(folder, sessionId, text);
      // Server auto-titles on first user message; refresh the sidebar entry
      // so the title chip stops saying "New chat".
      void refreshSessions(folder).catch(() => {});
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

  async function switchTo(f: string, s: string) {
    setFolder(f);
    setSessionId(s);
    pushUrl(f, s);
    setDrawerOpen(false);
  }

  async function newSession(f: string) {
    try {
      const created = await api.createChatSession(f);
      const row: WebSession = {
        id: created.id,
        folder: created.folder,
        title: created.title,
        sdkSessionId: null,
        createdAt: new Date().toISOString(),
        lastMessageAt: null,
        pinned: false,
        archived: false,
      };
      setSessionsByFolder((prev) => ({
        ...prev,
        [f]: [row, ...(prev[f] || [])],
      }));
      setFolder(f);
      setSessionId(created.id);
      pushUrl(f, created.id);
      setDrawerOpen(false);
      // Ensure the agent group is expanded so the new session is visible.
      setCollapsed((prev) => {
        if (!prev.has(f)) return prev;
        const next = new Set(prev);
        next.delete(f);
        saveCollapsed(next);
        return next;
      });
    } catch {
      /* ignore */
    }
  }

  function toggleCollapse(f: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      saveCollapsed(next);
      return next;
    });
  }

  async function commitRename(f: string, id: string) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await api.renameChatSession(f, id, title);
      setSessionsByFolder((prev) => ({
        ...prev,
        [f]: (prev[f] || []).map((s) => (s.id === id ? { ...s, title } : s)),
      }));
    } catch {
      /* ignore */
    }
  }

  async function deleteSession(f: string, id: string) {
    if (!confirm('Archive this conversation? It will be hidden from the list.'))
      return;
    try {
      await api.deleteChatSession(f, id, false);
      const remaining = (sessionsByFolder[f] || []).filter((s) => s.id !== id);
      setSessionsByFolder((prev) => ({ ...prev, [f]: remaining }));
      if (folder === f && sessionId === id) {
        const next = remaining[0]?.id || null;
        if (next) switchTo(f, next);
        else setSessionId(null);
      }
    } catch {
      /* ignore */
    }
  }

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

  const activeAgent = useMemo(
    () => agents.find((a) => a.folder === folder) || null,
    [agents, folder],
  );
  const activeSession = useMemo(() => {
    if (!folder || !sessionId) return null;
    return (
      (sessionsByFolder[folder] || []).find((s) => s.id === sessionId) || null
    );
  }, [folder, sessionId, sessionsByFolder]);

  return (
    <>
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)] relative">
        {/* Sidebar */}
        <aside
          className={
            'bg-[color:var(--bg-2,#14171d)] border-r border-[color:var(--border)] flex flex-col min-w-0 ' +
            'fixed md:static inset-y-0 left-0 w-72 z-30 transform transition-transform duration-200 ' +
            (drawerOpen
              ? 'translate-x-0'
              : '-translate-x-full md:translate-x-0')
          }
        >
          <header className="px-3 py-3 flex items-center gap-2 border-b border-[color:var(--border)]">
            <div className="text-base font-semibold flex-1">NanoClaw</div>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="md:hidden text-[color:var(--muted)] hover:text-[color:var(--fg)] px-2 text-lg"
              aria-label="Close sidebar"
            >
              ✕
            </button>
          </header>
          <nav className="flex-1 overflow-y-auto py-2">
            {agents.map((a) => {
              const sessions = sessionsByFolder[a.folder] || [];
              const isCollapsed = collapsed.has(a.folder);
              const isActiveAgent = folder === a.folder;
              return (
                <div key={a.folder} className="mb-1">
                  <div
                    className="px-2 py-1.5 flex items-center gap-2 cursor-pointer hover:bg-[color:var(--card)] mx-1 rounded-md"
                    onClick={() => toggleCollapse(a.folder)}
                  >
                    <span
                      className="w-3 text-[10px] text-[color:var(--muted)] transition-transform"
                      style={{
                        transform: isCollapsed ? 'rotate(-90deg)' : 'none',
                      }}
                    >
                      ▾
                    </span>
                    <span
                      className="w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold text-white shrink-0"
                      style={{ background: avatarColor(a.folder) }}
                    >
                      {initials(a.name || a.folder)}
                    </span>
                    <span className="flex-1 text-[13px] font-medium truncate">
                      {a.name || a.folder}
                    </span>
                    {isActiveAgent && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--accent)]" />
                    )}
                    <span className="text-[11px] text-[color:var(--muted)] bg-[color:var(--card)] rounded-full px-1.5">
                      {sessions.length}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void newSession(a.folder);
                      }}
                      aria-label="New session"
                      title="New session"
                      className="text-[color:var(--muted)] hover:text-[color:var(--accent)] px-1 text-base leading-none"
                    >
                      ＋
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="pl-1">
                      {sessions.length === 0 && (
                        <div className="px-10 py-1 text-[11px] text-[color:var(--muted)] italic">
                          no sessions yet
                        </div>
                      )}
                      {sessions.map((s) => {
                        const active =
                          a.folder === folder && s.id === sessionId;
                        const isRenaming = renamingId === s.id;
                        return (
                          <div
                            key={s.id}
                            className={
                              'group flex items-center gap-2 pl-10 pr-2 py-1 mx-1 rounded-md cursor-pointer ' +
                              (active
                                ? 'bg-[color:var(--accent)]/15'
                                : 'hover:bg-[color:var(--card)]')
                            }
                            onClick={() =>
                              !isRenaming && void switchTo(a.folder, s.id)
                            }
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              setRenamingId(s.id);
                              setRenameDraft(s.title || '');
                            }}
                          >
                            {isRenaming ? (
                              <input
                                autoFocus
                                value={renameDraft}
                                onChange={(e) => setRenameDraft(e.target.value)}
                                onBlur={() => commitRename(a.folder, s.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void commitRename(a.folder, s.id);
                                  } else if (e.key === 'Escape') {
                                    setRenamingId(null);
                                  }
                                }}
                                className="flex-1 bg-transparent border border-[color:var(--accent)] rounded px-1 text-[12.5px] focus:outline-none"
                              />
                            ) : (
                              <span
                                className={
                                  'flex-1 text-[12.5px] truncate ' +
                                  (active ? 'text-[color:var(--accent)]' : '')
                                }
                              >
                                {s.title || (
                                  <span className="text-[color:var(--muted)] italic">
                                    New chat
                                  </span>
                                )}
                              </span>
                            )}
                            <span className="text-[11px] text-[color:var(--muted)] shrink-0">
                              {shortWhen(s.lastMessageAt || s.createdAt)}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void deleteSession(a.folder, s.id);
                              }}
                              className="opacity-0 group-hover:opacity-100 text-[color:var(--muted)] hover:text-red-400 text-xs shrink-0"
                              aria-label="Archive session"
                              title="Archive"
                            >
                              ⌫
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <div className="border-t border-[color:var(--border)] px-2 py-2 space-y-0.5">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-[color:var(--card)] transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings</span>
            </button>
            <Link
              href="/admin"
              className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-[color:var(--card)] transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
              <span>Admin</span>
            </Link>
          </div>
        </aside>
        {drawerOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/40 z-20"
            onClick={() => setDrawerOpen(false)}
          />
        )}

        {/* Main pane */}
        <section className="flex flex-col min-h-0">
          <div className="border-b border-[color:var(--border)] px-3 py-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="md:hidden h-8 w-8 rounded-md border border-[color:var(--border)] inline-flex items-center justify-center text-[color:var(--muted)] hover:text-[color:var(--fg)]"
              aria-label="Open sidebar"
            >
              ☰
            </button>
            {activeAgent && (
              <span className="inline-flex items-center gap-1.5 bg-[color:var(--card)] border border-[color:var(--border)] rounded-full px-2 py-0.5 text-xs shrink-0">
                <span
                  className="w-4 h-4 rounded-full grid place-items-center text-[9px] font-bold text-white"
                  style={{ background: avatarColor(activeAgent.folder) }}
                >
                  {initials(activeAgent.name || activeAgent.folder)}
                </span>
                <span className="truncate max-w-[8rem]">
                  {activeAgent.name || activeAgent.folder}
                </span>
              </span>
            )}
            <span className="text-sm font-medium truncate flex-1 min-w-0">
              {activeSession?.title || (
                <span className="text-[color:var(--muted)] italic">
                  {activeSession ? 'New chat' : 'No session'}
                </span>
              )}
            </span>
            {(activity || typing) && (
              <span className="text-xs text-[color:var(--muted)] truncate max-w-[14rem]">
                … {activity || 'typing'}
              </span>
            )}
          </div>
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
          >
            {loadingHistory && (
              <div className="text-center text-xs text-[color:var(--muted)]">
                loading history…
              </div>
            )}
            {!loadingHistory && messages.length === 0 && (
              <div className="h-full flex items-center justify-center text-center px-6">
                <div className="text-[color:var(--muted)] text-sm">
                  {folder && sessionId ? (
                    <>
                      New conversation with{' '}
                      <span className="font-medium">{folder}</span>.<br />
                      Type a message below to start.
                    </>
                  ) : (
                    'Pick or start a conversation from the sidebar.'
                  )}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} data-msg-id={m.id}>
                <Bubble m={m} />
              </div>
            ))}
            {(activity || typing) && messages.length > 0 && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md bg-[color:var(--card)] border border-[color:var(--border)] px-3 py-2 text-sm text-[color:var(--muted)] animate-pulse max-w-full truncate">
                  {activity ? `… ${activity}` : '…'}
                </div>
              </div>
            )}
            {messages.length > 0 && <div ref={bottomSpacerRef} aria-hidden />}
          </div>
          <form
            className="border-t border-[color:var(--border)] p-2 flex gap-2 items-end"
            style={{
              paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
            }}
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
              disabled={!folder || !sessionId || uploading || recording}
              onClick={() => fileInputRef.current?.click()}
              className="h-9 inline-flex items-center justify-center rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 text-sm leading-none transition-all duration-150 hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]/10 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[color:var(--card)] disabled:hover:border-[color:var(--border)] disabled:active:scale-100"
              title="Attach file"
            >
              📎
            </button>
            <button
              type="button"
              aria-label={recording ? 'Stop recording' : 'Record voice'}
              disabled={!folder || !sessionId || uploading}
              onClick={() =>
                recording ? stopRecording() : void startRecording()
              }
              className={
                'h-9 inline-flex items-center justify-center rounded-md border px-3 text-sm leading-none transition-all duration-150 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ' +
                (recording
                  ? 'border-red-500 bg-red-500/20 text-red-300 animate-pulse'
                  : 'border-[color:var(--border)] bg-[color:var(--card)] hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]/10')
              }
              title={recording ? 'Stop recording' : 'Record voice message'}
            >
              {recording ? '⏹' : '🎙'}
            </button>
            <div className="relative flex-1 min-w-0">
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
                        'w-full text-left px-3 py-1.5 text-sm flex gap-3 items-baseline transition-colors duration-100 ' +
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
                placeholder={
                  folder && sessionId
                    ? `Message ${activeAgent?.name || folder}…`
                    : 'Pick or start a conversation'
                }
                className="w-full block min-h-9 resize-none overflow-y-auto bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[color:var(--accent)] leading-5 align-bottom"
              />
            </div>
            <button
              type="submit"
              disabled={!folder || !sessionId || !input.trim() || sending}
              className="h-9 inline-flex items-center justify-center rounded-md bg-[color:var(--accent)] text-white px-4 text-sm leading-none transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100"
            >
              Send
            </button>
          </form>
        </section>
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}
