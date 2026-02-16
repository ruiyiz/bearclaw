# Output Formatting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert raw LLM Markdown to platform-native formatting (WhatsApp markup / Telegram HTML) before sending messages.

**Architecture:** Each channel class internally converts Markdown via `marked` AST renderers. A shared `src/format.ts` module exports renderer classes and a `renderMarkdown()` helper. The `formatOutbound` function and `prefixAssistantName` property are removed; display name prefixing moves into WhatsApp's `sendMessage`.

**Tech Stack:** `marked` (Markdown parser), TypeScript, `bun test` for testing

---

### Task 1: Install marked and set up test infrastructure

**Files:**
- Modify: `package.json`

**Step 1: Install marked**

Run: `bun add marked`

**Step 2: Install bun test types**

Run: `bun add -d @types/bun`

**Step 3: Verify bun test works**

Create a smoke test file `src/format.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';

describe('smoke test', () => {
  it('works', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `bun test src/format.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add package.json bun.lockb src/format.test.ts
git commit -m "Add marked dependency and bun test infrastructure"
```

---

### Task 2: Implement Telegram HTML renderer with tests

**Files:**
- Create: `src/format.ts`
- Modify: `src/format.test.ts`

**Step 1: Write tests for Telegram HTML rendering**

Replace `src/format.test.ts` with:

```typescript
import { describe, it, expect } from 'bun:test';
import { renderMarkdown, TelegramHtmlRenderer } from './format.js';

const tg = (md: string) => renderMarkdown(md, new TelegramHtmlRenderer());

describe('TelegramHtmlRenderer', () => {
  it('converts bold', () => {
    expect(tg('**bold**')).toBe('<b>bold</b>');
  });

  it('converts italic', () => {
    expect(tg('*italic*')).toBe('<i>italic</i>');
  });

  it('converts strikethrough', () => {
    expect(tg('~~strike~~')).toBe('<s>strike</s>');
  });

  it('converts inline code', () => {
    expect(tg('`code`')).toBe('<code>code</code>');
  });

  it('converts code blocks', () => {
    expect(tg('```js\nconst x = 1;\n```')).toBe(
      '<pre><code class="language-js">const x = 1;\n</code></pre>'
    );
  });

  it('converts code blocks without language', () => {
    expect(tg('```\nplain\n```')).toBe('<pre><code>plain\n</code></pre>');
  });

  it('converts headers to bold', () => {
    expect(tg('# Title')).toBe('<b>Title</b>');
    expect(tg('## Subtitle')).toBe('<b>Subtitle</b>');
  });

  it('converts links', () => {
    expect(tg('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>'
    );
  });

  it('converts blockquotes', () => {
    expect(tg('> quoted text')).toBe('<blockquote>quoted text</blockquote>');
  });

  it('converts unordered lists to plain text', () => {
    expect(tg('- item one\n- item two')).toBe('- item one\n- item two');
  });

  it('converts ordered lists to plain text', () => {
    expect(tg('1. first\n2. second')).toBe('1. first\n2. second');
  });

  it('converts images to text fallback', () => {
    expect(tg('![alt text](https://img.png)')).toBe('alt text (https://img.png)');
  });

  it('converts horizontal rule', () => {
    expect(tg('---')).toBe('\u2014\u2014\u2014');
  });

  it('escapes HTML entities in text', () => {
    expect(tg('1 < 2 & 3 > 1')).toBe('1 &lt; 2 &amp; 3 &gt; 1');
  });

  it('does not escape inside code blocks', () => {
    expect(tg('`a < b`')).toBe('<code>a &lt; b</code>');
  });

  it('handles plain text passthrough', () => {
    expect(tg('just plain text')).toBe('just plain text');
  });

  it('handles nested bold + italic', () => {
    expect(tg('**_bold italic_**')).toBe('<b><i>bold italic</i></b>');
  });
});
```

Run: `bun test src/format.test.ts`
Expected: FAIL (module not found)

**Step 2: Implement TelegramHtmlRenderer**

Create `src/format.ts`:

```typescript
import { Renderer, marked } from 'marked';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class TelegramHtmlRenderer extends Renderer {
  heading({ text, depth }: { text: string; depth: number }): string {
    return `<b>${text}</b>\n`;
  }

  paragraph({ text }: { text: string }): string {
    return `${text}\n`;
  }

  strong({ text }: { text: string }): string {
    return `<b>${text}</b>`;
  }

  em({ text }: { text: string }): string {
    return `<i>${text}</i>`;
  }

  del({ text }: { text: string }): string {
    return `<s>${text}</s>`;
  }

  codespan({ text }: { text: string }): string {
    return `<code>${escapeHtml(text)}</code>`;
  }

  code({ text, lang }: { text: string; lang?: string }): string {
    const cls = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${cls}>${escapeHtml(text)}\n</code></pre>\n`;
  }

  blockquote({ text }: { text: string }): string {
    return `<blockquote>${text.trim()}</blockquote>\n`;
  }

  link({ href, text }: { href: string; text: string }): string {
    return `<a href="${escapeHtml(href)}">${text}</a>`;
  }

  image({ href, text }: { href: string; text: string }): string {
    return `${text} (${href})`;
  }

  list({ items, ordered, start }: { items: string[]; ordered: boolean; start: number }): string {
    return items.join('') + '\n';
  }

  listitem({ text, task, checked }: { text: string; task: boolean; checked: boolean }): string {
    // The list method's ordered/start context isn't available here,
    // so we handle numbering in list() instead if needed.
    // For now, return text with a dash prefix (list() will assemble).
    return `${text}\n`;
  }

  hr(): string {
    return '\u2014\u2014\u2014\n';
  }

  text({ text }: { text: string }): string {
    return text;
  }

  html({ text }: { text: string }): string {
    return escapeHtml(text);
  }

  br(): string {
    return '\n';
  }
}

export function renderMarkdown(markdown: string, renderer: Renderer): string {
  try {
    const result = marked(markdown, { renderer, async: false }) as string;
    return result.trim();
  } catch {
    return markdown.trim();
  }
}
```

Note: The test assertions above are approximate. The exact output depends on how `marked` tokenizes and calls the renderer. After implementing, run the tests, read the actual output, and adjust assertions to match the real rendering behavior. The important thing is that the semantic conversion is correct (bold → `<b>`, italic → `<i>`, etc.).

Run: `bun test src/format.test.ts`
Expected: Most tests pass. Adjust any assertions that don't match `marked`'s actual tokenization behavior.

**Step 3: Iterate until all tests pass**

Fix any mismatches between expected output and actual `marked` rendering. Common issues:
- `marked` may wrap text in `<p>` tags by default — the renderer's `paragraph()` method controls this
- List items may include nested paragraph wrapping
- Trailing newlines may differ

**Step 4: Commit**

```bash
git add src/format.ts src/format.test.ts
git commit -m "Add Telegram HTML renderer with tests"
```

---

### Task 3: Implement WhatsApp renderer with tests

**Files:**
- Modify: `src/format.ts`
- Modify: `src/format.test.ts`

**Step 1: Add WhatsApp renderer tests to `src/format.test.ts`**

Append:

```typescript
import { WhatsAppRenderer } from './format.js';

const wa = (md: string) => renderMarkdown(md, new WhatsAppRenderer());

describe('WhatsAppRenderer', () => {
  it('converts bold', () => {
    expect(wa('**bold**')).toBe('*bold*');
  });

  it('converts italic', () => {
    expect(wa('*italic*')).toBe('_italic_');
  });

  it('converts strikethrough', () => {
    expect(wa('~~strike~~')).toBe('~strike~');
  });

  it('converts inline code', () => {
    expect(wa('`code`')).toBe('`code`');
  });

  it('converts code blocks (strips language)', () => {
    expect(wa('```js\nconst x = 1;\n```')).toBe('```\nconst x = 1;\n```');
  });

  it('converts headers to bold', () => {
    expect(wa('# Title')).toBe('*Title*');
  });

  it('converts links to text + url', () => {
    expect(wa('[click](https://example.com)')).toBe('click (https://example.com)');
  });

  it('converts blockquotes', () => {
    expect(wa('> quoted')).toBe('> quoted');
  });

  it('passes through unordered lists', () => {
    expect(wa('- one\n- two')).toBe('- one\n- two');
  });

  it('passes through ordered lists', () => {
    expect(wa('1. one\n2. two')).toBe('1. one\n2. two');
  });

  it('converts images to text fallback', () => {
    expect(wa('![alt](https://img.png)')).toBe('alt (https://img.png)');
  });

  it('converts horizontal rule', () => {
    expect(wa('---')).toBe('\u2014\u2014\u2014');
  });

  it('handles plain text passthrough', () => {
    expect(wa('just plain text')).toBe('just plain text');
  });

  it('handles nested bold + italic', () => {
    expect(wa('**_bold italic_**')).toBe('*_bold italic_*');
  });
});
```

Run: `bun test src/format.test.ts`
Expected: FAIL (WhatsAppRenderer not found)

**Step 2: Implement WhatsAppRenderer in `src/format.ts`**

Add to `src/format.ts`:

```typescript
export class WhatsAppRenderer extends Renderer {
  heading({ text, depth }: { text: string; depth: number }): string {
    return `*${text}*\n`;
  }

  paragraph({ text }: { text: string }): string {
    return `${text}\n`;
  }

  strong({ text }: { text: string }): string {
    return `*${text}*`;
  }

  em({ text }: { text: string }): string {
    return `_${text}_`;
  }

  del({ text }: { text: string }): string {
    return `~${text}~`;
  }

  codespan({ text }: { text: string }): string {
    return `\`${text}\``;
  }

  code({ text }: { text: string }): string {
    return `\`\`\`\n${text}\n\`\`\`\n`;
  }

  blockquote({ text }: { text: string }): string {
    const lines = text.trim().split('\n');
    return lines.map((l) => `> ${l}`).join('\n') + '\n';
  }

  link({ href, text }: { href: string; text: string }): string {
    return `${text} (${href})`;
  }

  image({ href, text }: { href: string; text: string }): string {
    return `${text} (${href})`;
  }

  list({ items, ordered, start }: { items: string[]; ordered: boolean; start: number }): string {
    return items.join('') + '\n';
  }

  listitem({ text, task, checked }: { text: string; task: boolean; checked: boolean }): string {
    return `${text}\n`;
  }

  hr(): string {
    return '\u2014\u2014\u2014\n';
  }

  text({ text }: { text: string }): string {
    return text;
  }

  html({ text }: { text: string }): string {
    return text;
  }

  br(): string {
    return '\n';
  }
}
```

Run: `bun test src/format.test.ts`
Expected: All tests pass (adjust assertions as needed for `marked` behavior)

**Step 3: Commit**

```bash
git add src/format.ts src/format.test.ts
git commit -m "Add WhatsApp renderer with tests"
```

---

### Task 4: Integrate formatting into WhatsApp channel

**Files:**
- Modify: `src/channels/whatsapp.ts`

**Step 1: Update WhatsApp sendMessage to format and prefix**

In `src/channels/whatsapp.ts`:

1. Add imports at top:
```typescript
import { DISPLAY_NAME } from '../config.js';
import { renderMarkdown, WhatsAppRenderer } from '../format.js';
```

2. Remove the `prefixAssistantName = true;` line (line 29).

3. Replace `sendMessage` method (lines 140-148):
```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  if (!this.sock) return;
  try {
    const formatted = renderMarkdown(text, new WhatsAppRenderer());
    const prefixed = `${DISPLAY_NAME}: ${formatted}`;
    await this.sock.sendMessage(jid, { text: prefixed });
    logger.info({ jid, length: prefixed.length }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: No type errors

**Step 3: Commit**

```bash
git add src/channels/whatsapp.ts
git commit -m "Integrate markdown formatting into WhatsApp sendMessage"
```

---

### Task 5: Integrate formatting into Telegram channel

**Files:**
- Modify: `src/channels/telegram.ts`

**Step 1: Update Telegram sendMessage to format with HTML**

In `src/channels/telegram.ts`:

1. Add import at top:
```typescript
import { renderMarkdown, TelegramHtmlRenderer } from '../format.js';
```

2. Remove the `prefixAssistantName = false;` line (line 19).

3. Replace `sendMessage` method (lines 331-351):
```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  if (!this.bot) {
    logger.warn('Telegram bot not initialized');
    return;
  }

  try {
    const numericId = jid.replace(/^tg:/, '');
    const formatted = renderMarkdown(text, new TelegramHtmlRenderer());
    const MAX_LENGTH = 4096;
    if (formatted.length <= MAX_LENGTH) {
      await this.bot.api.sendMessage(numericId, formatted, { parse_mode: 'HTML' });
    } else {
      for (let i = 0; i < formatted.length; i += MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, formatted.slice(i, i + MAX_LENGTH), { parse_mode: 'HTML' });
      }
    }
    logger.info({ jid, length: formatted.length }, 'Telegram message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send Telegram message');
  }
}
```

**Step 2: Update sendPoolMessage to format with HTML**

In the `sendPoolMessage` function (line 466-530), update the text sending section (lines 518-525):

```typescript
const formatted = renderMarkdown(text, new TelegramHtmlRenderer());
const MAX_LENGTH = 4096;
if (formatted.length <= MAX_LENGTH) {
  await api.sendMessage(numericId, formatted, { parse_mode: 'HTML' });
} else {
  for (let i = 0; i < formatted.length; i += MAX_LENGTH) {
    await api.sendMessage(numericId, formatted.slice(i, i + MAX_LENGTH), { parse_mode: 'HTML' });
  }
}
```

Add the import for `TelegramHtmlRenderer` and `renderMarkdown` at the top of the file (same import added in step 1).

**Step 3: Verify build**

Run: `npm run build`
Expected: No type errors

**Step 4: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "Integrate markdown formatting into Telegram sendMessage and pool"
```

---

### Task 6: Remove formatOutbound and clean up index.ts

**Files:**
- Modify: `src/index.ts`
- Modify: `src/router.ts`
- Modify: `src/types.ts`

**Step 1: Remove formatOutbound from router.ts**

In `src/router.ts`, remove the `formatOutbound` function and the `DISPLAY_NAME` import. The file should become:

```typescript
import { Channel } from './types.js';

export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}
```

**Step 2: Remove prefixAssistantName from Channel interface**

In `src/types.ts`, remove line 19: `prefixAssistantName: boolean;`

**Step 3: Remove formatOutbound usage from index.ts**

In `src/index.ts`:

1. Update import (line 45): remove `formatOutbound` from the import:
```typescript
import { findChannel } from './router.js';
```

2. Line 145 — remove `formatOutbound` wrapper:
```typescript
await ch.sendMessage(msg.chat_jid, 'Session cleared! Starting fresh.');
```

3. Lines 189-190 — remove `formatOutbound` wrapper:
```typescript
await channel.sendMessage(msg.chat_jid, response);
```

4. Line 318 — IPC media caption: remove `formatOutbound` wrapper:
```typescript
const caption = data.text || undefined;
```

5. Lines 337-338 — IPC text message: remove `formatOutbound` wrapper:
```typescript
await ipcChannel.sendMessage(targetJid, data.text);
```

**Step 4: Remove DISPLAY_NAME import from index.ts if no longer used**

Check if `DISPLAY_NAME` is still used in `index.ts` (line 7). It's used on lines 155-157 for `botPrefixes`. Keep it if so.

**Step 5: Verify build**

Run: `npm run build`
Expected: No type errors

**Step 6: Run all tests**

Run: `bun test`
Expected: All pass

**Step 7: Commit**

```bash
git add src/index.ts src/router.ts src/types.ts
git commit -m "Remove formatOutbound, fold display name prefix into WhatsApp channel"
```

---

### Task 7: Manual smoke test

**Step 1: Run dev server**

Run: `npm run dev`

**Step 2: Send test messages through each channel**

Send a message containing markdown to a registered group:
- `**bold** and *italic* and ~~strike~~`
- `` `inline code` and ```code block``` ``
- `# Header\n> blockquote\n- list item`
- `[link text](https://example.com)`

**Step 3: Verify rendering**

- WhatsApp: bold rendered as bold, italic as italic, headers as bold text, links as `text (url)`
- Telegram: rich HTML formatting with bold, italic, code, clickable links, blockquotes

**Step 4: Test edge cases**

- Plain text message (no markdown) — should pass through cleanly
- Very long message (>4096 chars) on Telegram — should split correctly
- Agent-authored messages via pool bots — should also be formatted
