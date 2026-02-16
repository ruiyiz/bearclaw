# Output Formatting Design

Convert raw LLM Markdown output to optimal platform-native formatting before sending to WhatsApp and Telegram.

## Approach

AST-based conversion using `marked`. Parse Markdown once, render per-channel with custom `Renderer` subclasses.

## Flow

```
Raw LLM Markdown
  -> channel.sendMessage(jid, text)
      -> renderMarkdown(text, channelRenderer)
      -> send via platform API
```

Formatting is an internal concern of each channel class. The `Channel` interface (`sendMessage(jid, text)`) is unchanged.

## Markdown-to-Platform Mapping

| Markdown | WhatsApp | Telegram HTML |
|---|---|---|
| `**bold**` | `*bold*` | `<b>bold</b>` |
| `*italic*` / `_italic_` | `_italic_` | `<i>italic</i>` |
| `~~strike~~` | `~strike~` | `<s>strike</s>` |
| `` `code` `` | `` `code` `` | `<code>code</code>` |
| ` ```lang\nblock\n``` ` | ` ```block``` ` (no lang) | `<pre><code class="language-lang">block</code></pre>` |
| `# Header` | `*Header*` (bold) | `<b>Header</b>` |
| `> quote` | `> quote` | `<blockquote>quote</blockquote>` |
| `- item` / `* item` | `- item` | `- item` (plain text) |
| `1. item` | `1. item` | `1. item` (plain text) |
| `[text](url)` | `text (url)` | `<a href="url">text</a>` |
| `![alt](url)` | `alt (url)` | `alt (url)` |
| `---` | `---` | `---` |
| Tables | Aligned plain text | `<pre>` aligned columns |

## File Changes

### New files
- `src/format.ts` -- `WhatsAppRenderer`, `TelegramHtmlRenderer` (extend `marked.Renderer`), `renderMarkdown(text, renderer)` helper

### Modified files
- `src/channels/whatsapp.ts` -- `sendMessage` calls `renderMarkdown` with `WhatsAppRenderer`, prepends display name prefix
- `src/channels/telegram.ts` -- `sendMessage` and pool sending call `renderMarkdown` with `TelegramHtmlRenderer`, pass `{ parse_mode: 'HTML' }`
- `src/types.ts` -- remove `prefixAssistantName` from `Channel` interface
- `src/router.ts` -- remove `formatOutbound`
- `src/index.ts` -- remove all `formatOutbound()` call sites, pass raw text to `channel.sendMessage()`

### New dependency
- `marked` (Markdown parser)

## Escaping

- Telegram HTML: escape `<`, `>`, `&` in all text nodes
- WhatsApp: no escaping needed (formatting only triggers on matched delimiter pairs)

## Error Handling

If `marked` throws on malformed input, catch and send raw text unformatted.
