'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ChatMessage,
  type ChatStreamEvent,
  type SlashCommand,
  type UserAgent,
} from '@/lib/api';
import {
  Bubble,
  channelLabelFromJid,
  parseMediaTag,
  type BubbleData,
} from '@/components/chat-bubble';

const TEXTAREA_MAX_PX = 240;
const HISTORY_LIMIT = 200;
const ALL_CHANNELS_KEY = 'nc.chat.allChannels';

function rowToBubble(
  m: ChatMessage,
  folder: string,
  showChannel: boolean,
): BubbleData {
  const parsed = parseMediaTag(m.content, folder);
  return {
    id: `db-${m.id}`,
    side: m.isFromMe ? 'agent' : 'user',
    text: parsed?.text ?? m.content,
    ts: m.timestamp ? Date.parse(m.timestamp) || 0 : 0,
    media: parsed?.media,
    channelLabel: showChannel ? channelLabelFromJid(m.chatJid) : undefined,
  };
}

export function ChatView() {
  const [agents, setAgents] = useState<UserAgent[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [messages, setMessages] = useState<BubbleData[]>([]);
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
  const [allChannels, setAllChannels] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setAllChannels(window.localStorage.getItem(ALL_CHANNELS_KEY) === '1');
  }, []);

  function toggleAllChannels(next: boolean) {
    setAllChannels(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ALL_CHANNELS_KEY, next ? '1' : '0');
    }
  }

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

  // Load message history for the selected agent. The web channel owns its
  // own persistence (messages table) so this is just the agent's linear
  // chat history — not split by SDK sessions.
  useEffect(() => {
    if (!folder) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    api
      .chatMessages(folder, { limit: HISTORY_LIMIT, allChannels })
      .then((d) => {
        if (cancelled) return;
        // DB returns newest-first; reverse for chronological render.
        const rows = [...d.messages].reverse();
        setMessages(rows.map((m) => rowToBubble(m, folder, allChannels)));
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
  }, [folder, allChannels]);

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
    setTyping(false);
    // SSE is web-only; tag bubbles with the web channel label when the
    // cross-channel view is active so the user sees a consistent chip column.
    const liveLabel = allChannels ? 'web' : undefined;
    setMessages((prev) => {
      switch (evt.type) {
        case 'message':
          // De-dupe against the row the server already persisted: if a bubble
          // with the same remoteId is present, skip; otherwise append.
          if (prev.some((m) => m.remoteId === evt.id)) return prev;
          return [
            ...prev,
            {
              id: `r-${evt.id}`,
              side: 'agent',
              text: evt.text,
              ts: evt.ts,
              remoteId: evt.id,
              channelLabel: liveLabel,
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
              channelLabel: liveLabel,
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
        channelLabel: allChannels ? 'web' : undefined,
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
        const localId = `v-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: localId,
            side: 'user',
            text: '[Voice message] (uploading…)',
            ts: Date.now(),
            channelLabel: allChannels ? 'web' : undefined,
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
    const text = input.trim();
    setInput('');
    setSending(true);
    setMessages((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        side: 'user',
        text,
        ts: Date.now(),
        channelLabel: allChannels ? 'web' : undefined,
      },
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
        <label className="text-xs text-[color:var(--muted)] ml-2 inline-flex items-center gap-1 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={allChannels}
            onChange={(e) => toggleAllChannels(e.target.checked)}
            className="accent-[color:var(--accent)]"
          />
          all channels
        </label>
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
            loading history…
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
