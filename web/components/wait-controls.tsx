'use client';

import { useState } from 'react';

import { api, type WorkflowWait } from '@/lib/api';
import { shortTime } from '@/lib/format';

export function WaitControls({
  wait,
  onDone,
}: {
  wait: WorkflowWait;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const respond = async (response: unknown) => {
    setBusy(true);
    try {
      await api.respondToWait(wait.id, response);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {wait.prompt && (
        <p className="text-[13px] leading-relaxed">{wait.prompt}</p>
      )}
      {wait.options?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {wait.options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={busy}
              onClick={() => respond({ choice: o })}
              className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[12px] hover:bg-[color:var(--bg)]"
            >
              {o}
            </button>
          ))}
        </div>
      ) : (
        <>
          {wait.kind === 'approve' && (
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => respond({ approved: true })}
                className="rounded-md border border-[color:var(--ok-border)] px-2.5 py-1 text-[12px] text-[color:var(--ok)] hover:bg-[color:var(--bg)]"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => respond({ approved: false })}
                className="rounded-md border border-[color:var(--danger-border)] px-2.5 py-1 text-[12px] text-[color:var(--danger)] hover:bg-[color:var(--bg)]"
              >
                Reject
              </button>
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Answer here"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) respond({ text });
              }}
              className="min-w-0 flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[color:var(--accent)]"
            />
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => respond({ text })}
              className="rounded-md bg-[color:var(--accent)] px-3 py-1 text-[12.5px] font-medium text-[color:var(--on-accent)] disabled:opacity-50"
            >
              Answer
            </button>
          </div>
        </>
      )}
      <p className="text-[11px] leading-relaxed text-[color:var(--muted)]">
        Answering here does the same work a reply on the original channel would,
        and closes the step. Whichever lands first wins.
        {wait.expiresAt ? ` Expires ${shortTime(wait.expiresAt)}.` : ''}
      </p>
    </div>
  );
}
