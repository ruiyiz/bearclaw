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
const TEXTAREA_MIN_PX = 24;
const TEXTAREA_WELCOME_MIN_PX = 56;
const HISTORY_LIMIT = 200;

function greetingForHour(hour: number): string {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const WELCOME_MESSAGES: string[] = [
  '{tod}. What are we hatching?',
  '{tod}. Where do we begin?',
  '{tod}. Plot the next move.',
  'Ahoy. Ready to dig in?',
  "What's on your mind?",
  'Yo. State the mission.',
  'Awaiting instructions.',
  'The cave is warm. Step in.',
  'Ready to think out loud?',
  '{tod}. Brew something with me.',
  'Quiet here. What shall we stir up?',
  'Sharpen your thoughts. I am listening.',
  '{tod}. Throw an idea at the wall.',
  "Let's make something weird.",
];

function pickWelcomeMessage(): string {
  const idx = Math.floor(Math.random() * WELCOME_MESSAGES.length);
  const template = WELCOME_MESSAGES[idx];
  const tod = greetingForHour(new Date().getHours());
  return template.replace('{tod}', tod);
}

interface ModelOption {
  id: string;
  label: string;
}
const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = (typeof EFFORT_OPTIONS)[number];

function modelLabel(id: string): string {
  return MODEL_OPTIONS.find((m) => m.id === id)?.label || id;
}
function effortLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

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

function urlState(): { folder: string | null; session: string | null } {
  if (typeof window === 'undefined') return { folder: null, session: null };
  const sp = new URLSearchParams(window.location.search);
  return {
    folder: sp.get('folder'),
    session: sp.get('session'),
  };
}

function pushUrl(folder: string, session: string | null): void {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams(window.location.search);
  sp.set('folder', folder);
  if (session) sp.set('session', session);
  else sp.delete('session');
  const next = `${window.location.pathname}?${sp.toString()}`;
  window.history.replaceState({}, '', next);
}

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
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [composerMenu, setComposerMenu] = useState<boolean>(false);
  // model/effort reflect the active agent's persisted setting (server source).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [messages, setMessages] = useState<BubbleData[]>([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [scrolled, setScrolled] = useState(false);
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
  const skipReloadForRef = useRef<string | null>(null);

  const refreshSessions = useCallback(
    async (f: string): Promise<WebSession[]> => {
      const d = await api.chatSessions(f);
      setSessionsByFolder((prev) => ({ ...prev, [f]: d.sessions }));
      return d.sessions;
    },
    [],
  );

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
        setFolder(initialFolder);
        setSessionId(null);
        pushUrl(initialFolder, null);
      } catch {
        /* unauthed redirects via api helpers */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close any open popovers on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest('[data-popover]')) {
        setMenuFor(null);
        setComposerMenu(false);
        setAgentPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

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
    setScrolled(false);
    if (!folder || !sessionId) {
      setMessages([]);
      return;
    }
    if (skipReloadForRef.current === sessionId) {
      skipReloadForRef.current = null;
      return;
    }
    justLoadedRef.current = true;
    const cancel = reloadHistory(folder, sessionId, { showSpinner: true });
    return cancel;
  }, [folder, sessionId, reloadHistory]);

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

    if (bottomSpacerRef.current) {
      bottomSpacerRef.current.style.minHeight = `${el.clientHeight}px`;
    }

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

    if (messages.length > prev) {
      const last = messages[messages.length - 1];
      if (last.side === 'user') {
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

  const welcomeMode = !loadingHistory && messages.length === 0 && !!folder;

  const welcomeMessage = useMemo(
    () => pickWelcomeMessage(),
    [folder, sessionId],
  );

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const minPx = welcomeMode ? TEXTAREA_WELCOME_MIN_PX : TEXTAREA_MIN_PX;
    ta.style.height = 'auto';
    ta.style.height =
      Math.max(minPx, Math.min(ta.scrollHeight, TEXTAREA_MAX_PX)) + 'px';
  }, [input, welcomeMode]);

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

  const ensureSession = useCallback(
    async (f: string): Promise<string | null> => {
      if (sessionId) return sessionId;
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
        skipReloadForRef.current = created.id;
        setSessionId(created.id);
        pushUrl(f, created.id);
        return created.id;
      } catch {
        return null;
      }
    },
    [sessionId],
  );

  async function handleFile(file: File) {
    if (!folder || uploading) return;
    const sid = await ensureSession(folder);
    if (!sid) return;
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
        sessionId: sid,
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
    const sid = await ensureSession(folder);
    if (!sid) return;
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
            sessionId: sid,
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

  async function sendText(text: string) {
    if (!folder || !text.trim()) return;
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, side: 'user', text, ts: Date.now() },
    ]);
    try {
      const sid = await ensureSession(folder);
      if (!sid) throw new Error('failed to create session');
      await api.chat(folder, sid, text);
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

  async function send() {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    if (loadKeepFocusOnSend()) textareaRef.current?.focus();
    await sendText(text);
  }

  async function switchTo(f: string, s: string) {
    setScrolled(false);
    setMessages([]);
    setFolder(f);
    setSessionId(s);
    pushUrl(f, s);
    setDrawerOpen(false);
  }

  async function newSession(f: string) {
    setScrolled(false);
    setMessages([]);
    setFolder(f);
    setSessionId(null);
    pushUrl(f, null);
    setDrawerOpen(false);
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

  async function updateActiveAgentModel(model: string) {
    if (!folder) return;
    setAgents((prev) =>
      prev.map((a) => (a.folder === folder ? { ...a, model } : a)),
    );
    setComposerMenu(false);
    try {
      await api.updateAgent(folder, { model });
    } catch {
      /* ignore — UI will re-sync on next userAgents fetch */
    }
  }

  async function updateActiveAgentEffort(effort: EffortLevel) {
    if (!folder) return;
    setAgents((prev) =>
      prev.map((a) => (a.folder === folder ? { ...a, effort } : a)),
    );
    setComposerMenu(false);
    try {
      await api.updateAgent(folder, { effort });
    } catch {
      /* ignore */
    }
  }

  async function togglePin(f: string, s: WebSession) {
    const next = !s.pinned;
    setSessionsByFolder((prev) => ({
      ...prev,
      [f]: (prev[f] || []).map((row) =>
        row.id === s.id ? { ...row, pinned: next } : row,
      ),
    }));
    try {
      await api.pinChatSession(f, s.id, next);
    } catch {
      setSessionsByFolder((prev) => ({
        ...prev,
        [f]: (prev[f] || []).map((row) =>
          row.id === s.id ? { ...row, pinned: !next } : row,
        ),
      }));
    }
  }

  async function regenerateTitle(f: string, id: string) {
    setRegeneratingId(id);
    try {
      const res = await api.regenerateChatSessionTitle(f, id);
      if (res.title) {
        setSessionsByFolder((prev) => ({
          ...prev,
          [f]: (prev[f] || []).map((s) =>
            s.id === id ? { ...s, title: res.title } : s,
          ),
        }));
      }
    } catch {
      /* ignore */
    } finally {
      setRegeneratingId(null);
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

  const sessionsForActive = useMemo(() => {
    if (!folder) return [] as WebSession[];
    return sessionsByFolder[folder] || [];
  }, [folder, sessionsByFolder]);

  const pinnedSessions = useMemo(
    () => sessionsForActive.filter((s) => s.pinned),
    [sessionsForActive],
  );
  const recentSessions = useMemo(
    () => sessionsForActive.filter((s) => !s.pinned),
    [sessionsForActive],
  );

  const lastUserTextBeforeAgent = useCallback(
    (agentIdx: number): string | null => {
      for (let i = agentIdx - 1; i >= 0; i--) {
        if (messages[i].side === 'user' && messages[i].text)
          return messages[i].text;
      }
      return null;
    },
    [messages],
  );

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setScrolled(el.scrollTop > 2);
  }

  const composerForm = (
    <form
      className="px-3 md:px-6 lg:px-10 pt-2"
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
      <div className="max-w-3xl mx-auto">
        <div
          data-popover
          className="relative rounded-3xl bg-[color:var(--card)] border border-[color:var(--border)] focus-within:border-[color:var(--accent)]/60 transition-colors px-3 pt-3 pb-2 shadow-sm"
        >
          {pickerVisible && (
            <div className="absolute bottom-full left-0 right-0 mb-2 max-h-60 overflow-y-auto rounded-2xl border border-[color:var(--border)] bg-[color:var(--card)] shadow-lg z-10">
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
            rows={welcomeMode ? 2 : 1}
            placeholder={
              folder
                ? `Message ${activeAgent?.name || folder}…`
                : 'Pick or start a conversation'
            }
            className="w-full block resize-none overflow-y-auto bg-transparent border-0 px-1 text-sm focus:outline-none leading-6 placeholder:text-[color:var(--muted)]"
            style={{
              minHeight: welcomeMode
                ? `${TEXTAREA_WELCOME_MIN_PX}px`
                : `${TEXTAREA_MIN_PX}px`,
            }}
          />
          <div className="mt-1 flex items-center gap-1 flex-wrap">
            <button
              type="button"
              aria-label="Attach file"
              title="Attach file"
              disabled={!folder || uploading || recording}
              onClick={() => fileInputRef.current?.click()}
              className="h-8 w-8 inline-flex items-center justify-center rounded-full text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-white/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              type="button"
              aria-label={recording ? 'Stop recording' : 'Record voice'}
              title={recording ? 'Stop recording' : 'Record voice message'}
              disabled={!folder || uploading}
              onClick={() =>
                recording ? stopRecording() : void startRecording()
              }
              className={
                'h-8 w-8 inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ' +
                (recording
                  ? 'text-red-400 bg-red-500/15 animate-pulse'
                  : 'text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-white/5')
              }
            >
              {recording ? (
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0" />
                  <line x1="12" y1="18" x2="12" y2="22" />
                </svg>
              )}
            </button>
            <div className="flex-1" />
            {activeAgent && (
              <div className="relative" data-popover>
                <button
                  type="button"
                  onClick={() => setComposerMenu((v) => !v)}
                  className="h-7 inline-flex items-center gap-1 rounded-full px-2.5 text-[11px] text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-white/5 border border-[color:var(--border)] transition-colors"
                >
                  <span>
                    {modelLabel(activeAgent.model)}
                    <span className="opacity-60"> · </span>
                    {effortLabel(activeAgent.effort)}
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    width="10"
                    height="10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {composerMenu && folder && (
                  <div className="absolute bottom-full right-0 mb-2 min-w-[12rem] rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] shadow-lg z-20 py-1">
                    <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                      Model
                    </div>
                    {MODEL_OPTIONS.map((opt) => (
                      <MenuItem
                        key={opt.id}
                        label={opt.label}
                        active={activeAgent.model === opt.id}
                        onClick={() => {
                          void updateActiveAgentModel(opt.id);
                        }}
                      />
                    ))}
                    <div className="h-px my-1 bg-[color:var(--border)]" />
                    <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                      Effort
                    </div>
                    {EFFORT_OPTIONS.map((opt) => (
                      <MenuItem
                        key={opt}
                        label={effortLabel(opt)}
                        active={activeAgent.effort === opt}
                        onClick={() => {
                          void updateActiveAgentEffort(opt);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              type="submit"
              aria-label="Send"
              disabled={!folder || !input.trim() || sending}
              className="h-8 w-8 inline-flex items-center justify-center rounded-full bg-[color:var(--accent)] text-white transition-all duration-150 hover:brightness-110 active:scale-95 disabled:bg-[color:var(--border)] disabled:text-[color:var(--muted)] disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="text-center text-[10px] text-[color:var(--muted)] mt-1.5 px-2">
          NanoClaw is AI and can make mistakes. Verify important info.
        </div>
      </div>
    </form>
  );

  return (
    <>
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)] relative">
        <SidebarPane
          agents={agents}
          activeAgent={activeAgent}
          folder={folder}
          sessionId={sessionId}
          pinnedSessions={pinnedSessions}
          recentSessions={recentSessions}
          agentPickerOpen={agentPickerOpen}
          setAgentPickerOpen={setAgentPickerOpen}
          menuFor={menuFor}
          setMenuFor={setMenuFor}
          drawerOpen={drawerOpen}
          setDrawerOpen={setDrawerOpen}
          setSettingsOpen={setSettingsOpen}
          renamingId={renamingId}
          setRenamingId={setRenamingId}
          renameDraft={renameDraft}
          setRenameDraft={setRenameDraft}
          regeneratingId={regeneratingId}
          switchTo={switchTo}
          newSession={newSession}
          commitRename={commitRename}
          regenerateTitle={regenerateTitle}
          deleteSession={deleteSession}
          togglePin={togglePin}
          setFolder={(f) => {
            setFolder(f);
            setSessionId(null);
            pushUrl(f, null);
          }}
        />

        {drawerOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/40 z-20"
            onClick={() => setDrawerOpen(false)}
          />
        )}

        <section className="flex flex-col min-h-0 relative">
          {(() => {
            const pageHeader = (
              <div
                className={
                  'sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-[color:var(--bg)]/70 px-3 md:px-6 lg:px-10 py-2 flex items-center gap-2 ' +
                  (welcomeMode
                    ? 'border-b border-transparent'
                    : scrolled
                      ? 'border-b border-[color:var(--border)] transition-[border-color] duration-200'
                      : 'border-b border-transparent transition-[border-color] duration-200')
                }
              >
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="md:hidden h-8 w-8 rounded-md border border-[color:var(--border)] inline-flex items-center justify-center text-[color:var(--muted)] hover:text-[color:var(--fg)]"
                  aria-label="Open sidebar"
                >
                  ☰
                </button>
                <span className="text-sm font-medium truncate flex-1 min-w-0">
                  {activeSession?.title ||
                    (welcomeMode ? (
                      ''
                    ) : (
                      <span className="text-[color:var(--muted)] italic">
                        {folder ? 'New chat' : 'No session'}
                      </span>
                    ))}
                </span>
                {(activity || typing) && (
                  <span className="text-[11px] text-[color:var(--muted)] truncate max-w-[14rem]">
                    … {activity || 'typing'}
                  </span>
                )}
              </div>
            );
            if (welcomeMode) {
              return (
                <>
                  {pageHeader}
                  <div className="flex-1 flex flex-col items-stretch pt-[28dvh]">
                    <div className="px-3 md:px-6 lg:px-10 pb-4">
                      <div className="max-w-3xl mx-auto flex items-center justify-center gap-3 flex-wrap">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/logo.png" alt="" width={48} height={48} />
                        <h1 className="text-3xl md:text-4xl font-serif text-[color:var(--fg)]">
                          {welcomeMessage}
                        </h1>
                      </div>
                    </div>
                    {composerForm}
                  </div>
                </>
              );
            }
            return (
              <>
                <div
                  ref={scrollRef}
                  onScroll={handleScroll}
                  className="flex-1 overflow-y-auto"
                >
                  {pageHeader}
                  <div className="px-3 md:px-6 lg:px-10 py-3">
                    <div className="max-w-3xl mx-auto space-y-3">
                      {loadingHistory && (
                        <div className="text-center text-[11px] text-[color:var(--muted)]">
                          loading history…
                        </div>
                      )}
                      {(() => {
                        let lastAgentIdx = -1;
                        for (let i = messages.length - 1; i >= 0; i--) {
                          if (
                            messages[i].side === 'agent' &&
                            messages[i].text
                          ) {
                            lastAgentIdx = i;
                            break;
                          }
                        }
                        return messages.map((m, idx) => {
                          let onRegen: (() => void) | undefined;
                          if (m.side === 'agent') {
                            const prevUser = lastUserTextBeforeAgent(idx);
                            if (prevUser)
                              onRegen = () => void sendText(prevUser);
                          }
                          return (
                            <div key={m.id} data-msg-id={m.id}>
                              <Bubble
                                m={m}
                                onRegenerate={onRegen}
                                pinned={idx === lastAgentIdx}
                              />
                            </div>
                          );
                        });
                      })()}
                      {(activity || typing) && messages.length > 0 && (
                        <div className="flex justify-start">
                          <div className="text-sm text-[color:var(--muted)] animate-pulse px-1">
                            {activity ? `… ${activity}` : '…'}
                          </div>
                        </div>
                      )}
                      {messages.length > 0 && (
                        <div ref={bottomSpacerRef} aria-hidden />
                      )}
                    </div>
                  </div>
                </div>
                {composerForm}
              </>
            );
          })()}
        </section>
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}

interface SidebarProps {
  agents: UserAgent[];
  activeAgent: UserAgent | null;
  folder: string | null;
  sessionId: string | null;
  pinnedSessions: WebSession[];
  recentSessions: WebSession[];
  agentPickerOpen: boolean;
  setAgentPickerOpen: (v: boolean) => void;
  menuFor: string | null;
  setMenuFor: (v: string | null) => void;
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  renamingId: string | null;
  setRenamingId: (v: string | null) => void;
  renameDraft: string;
  setRenameDraft: (v: string) => void;
  regeneratingId: string | null;
  switchTo: (f: string, s: string) => void;
  newSession: (f: string) => void;
  commitRename: (f: string, id: string) => void;
  regenerateTitle: (f: string, id: string) => void;
  deleteSession: (f: string, id: string) => void;
  togglePin: (f: string, s: WebSession) => void;
  setFolder: (f: string) => void;
}

function SidebarPane(p: SidebarProps) {
  return (
    <aside
      className={
        'bg-[color:var(--bg-2,#14171d)] border-r border-[color:var(--border)] flex flex-col min-w-0 ' +
        'fixed md:static inset-y-0 left-0 w-72 z-30 transform transition-transform duration-200 ' +
        (p.drawerOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
      }
    >
      <header className="px-3 py-3 flex items-center gap-2">
        <div className="flex-1 flex items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="NanoClaw" width={32} height={32} />
        </div>
        <button
          type="button"
          onClick={() => p.setDrawerOpen(false)}
          className="md:hidden text-[color:var(--muted)] hover:text-[color:var(--fg)] px-2 text-lg"
          aria-label="Close sidebar"
        >
          ✕
        </button>
      </header>

      {/* New chat button */}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => p.folder && p.newSession(p.folder)}
          disabled={!p.folder}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-[color:var(--fg)] bg-[color:var(--card)] hover:bg-[color:var(--accent)]/15 hover:text-[color:var(--accent)] border border-[color:var(--border)] hover:border-[color:var(--accent)]/40 transition-colors disabled:opacity-50"
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
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>New chat</span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-1">
        {p.pinnedSessions.length > 0 && (
          <SessionGroup
            label="Starred"
            sessions={p.pinnedSessions}
            {...p}
            folder={p.folder!}
          />
        )}
        {p.recentSessions.length > 0 && (
          <SessionGroup
            label="Recents"
            sessions={p.recentSessions}
            {...p}
            folder={p.folder!}
          />
        )}
        {p.folder &&
          p.pinnedSessions.length === 0 &&
          p.recentSessions.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-[color:var(--muted)] italic">
              no chats yet
            </div>
          )}
      </nav>

      <div className="border-t border-[color:var(--border)] px-2 py-2 space-y-0.5">
        {/* Agent picker */}
        <div className="relative" data-popover>
          <button
            type="button"
            onClick={() => p.setAgentPickerOpen(!p.agentPickerOpen)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-[color:var(--card)] transition-colors"
          >
            {p.activeAgent && (
              <span
                className="w-6 h-6 rounded-full grid place-items-center text-[10px] font-bold text-white shrink-0"
                style={{ background: avatarColor(p.activeAgent.folder) }}
              >
                {initials(p.activeAgent.name || p.activeAgent.folder)}
              </span>
            )}
            <span className="flex-1 text-sm font-medium truncate text-left">
              {p.activeAgent?.name || p.activeAgent?.folder || 'Pick agent'}
            </span>
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[color:var(--muted)]"
            >
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          {p.agentPickerOpen && (
            <div className="absolute left-0 right-0 bottom-full mb-1 z-20 rounded-md border border-[color:var(--border)] bg-[color:var(--card)] shadow-lg py-1 max-h-72 overflow-y-auto">
              {p.agents.map((a) => {
                const active = a.folder === p.folder;
                return (
                  <button
                    type="button"
                    key={a.folder}
                    onClick={() => {
                      p.setFolder(a.folder);
                      p.setAgentPickerOpen(false);
                    }}
                    className={
                      'w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-white/5 ' +
                      (active ? 'text-[color:var(--accent)]' : '')
                    }
                  >
                    <span
                      className="w-5 h-5 rounded-full grid place-items-center text-[9px] font-bold text-white shrink-0"
                      style={{ background: avatarColor(a.folder) }}
                    >
                      {initials(a.name || a.folder)}
                    </span>
                    <span className="flex-1 truncate text-left">
                      {a.name || a.folder}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => p.setSettingsOpen(true)}
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
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
  active,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/5 disabled:opacity-50 ' +
        (danger ? 'text-red-400 ' : active ? 'text-[color:var(--accent)] ' : '')
      }
    >
      {icon && <span className="opacity-70 shrink-0">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

interface SessionGroupProps extends SidebarProps {
  label: string;
  sessions: WebSession[];
  folder: string;
}

function SessionGroup(p: SessionGroupProps) {
  return (
    <div className="mb-2">
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
        {p.label}
      </div>
      {p.sessions.map((s) => (
        <SessionRow key={s.id} s={s} {...p} />
      ))}
    </div>
  );
}

interface SessionRowProps extends SidebarProps {
  s: WebSession;
  folder: string;
}

function SessionRow(p: SessionRowProps) {
  const { s } = p;
  const active = p.folder === s.folder && p.sessionId === s.id;
  const isRenaming = p.renamingId === s.id;
  const menuOpen = p.menuFor === s.id;
  return (
    <div
      className={
        'group flex items-center gap-1 pl-3 pr-1 py-1 mx-1 rounded-md cursor-pointer relative ' +
        (active
          ? 'bg-[color:var(--accent)]/15'
          : 'hover:bg-[color:var(--card)]')
      }
      onClick={() => !isRenaming && p.switchTo(p.folder, s.id)}
      onDoubleClick={(e) => {
        e.preventDefault();
        p.setRenamingId(s.id);
        p.setRenameDraft(s.title || '');
      }}
    >
      {isRenaming ? (
        <input
          autoFocus
          value={p.renameDraft}
          onChange={(e) => p.setRenameDraft(e.target.value)}
          onBlur={() => p.commitRename(p.folder, s.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              p.commitRename(p.folder, s.id);
            } else if (e.key === 'Escape') {
              p.setRenamingId(null);
            }
          }}
          className="flex-1 bg-transparent border border-[color:var(--accent)] rounded px-1 text-[12.5px] focus:outline-none"
        />
      ) : (
        <span
          className={
            'flex-1 min-w-0 text-[12.5px] overflow-hidden whitespace-nowrap ' +
            (active ? 'text-[color:var(--accent)]' : '')
          }
          style={{
            maskImage:
              'linear-gradient(to right, black 0, black 85%, transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to right, black 0, black 85%, transparent 100%)',
          }}
        >
          {s.title || (
            <span className="text-[color:var(--muted)] italic">New chat</span>
          )}
        </span>
      )}
      {!isRenaming && (
        <div className="relative" data-popover>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              p.setMenuFor(menuOpen ? null : s.id);
            }}
            aria-label="More actions"
            className={
              'h-5 w-5 inline-flex items-center justify-center rounded text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-white/10 transition-opacity ' +
              (active || menuOpen
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100')
            }
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 z-20 min-w-[10rem] rounded-md border border-[color:var(--border)] bg-[color:var(--card)] shadow-lg py-1 text-sm"
              onClick={(e) => e.stopPropagation()}
            >
              <MenuItem
                onClick={() => {
                  p.togglePin(p.folder, s);
                  p.setMenuFor(null);
                }}
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    fill={s.pinned ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                }
                label={s.pinned ? 'Unstar' : 'Star'}
              />
              <MenuItem
                onClick={() => {
                  p.setRenamingId(s.id);
                  p.setRenameDraft(s.title || '');
                  p.setMenuFor(null);
                }}
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                }
                label="Rename"
              />
              <MenuItem
                disabled={p.regeneratingId === s.id}
                onClick={() => {
                  p.regenerateTitle(p.folder, s.id);
                  p.setMenuFor(null);
                }}
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={p.regeneratingId === s.id ? 'animate-spin' : ''}
                  >
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                }
                label={
                  p.regeneratingId === s.id
                    ? 'Regenerating…'
                    : 'Regenerate title'
                }
              />
              <div className="h-px my-1 bg-[color:var(--border)]" />
              <MenuItem
                onClick={() => {
                  p.deleteSession(p.folder, s.id);
                  p.setMenuFor(null);
                }}
                danger
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="21 8 21 21 3 21 3 8" />
                    <rect x="1" y="3" width="22" height="5" />
                    <line x1="10" y1="12" x2="14" y2="12" />
                  </svg>
                }
                label="Archive"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
