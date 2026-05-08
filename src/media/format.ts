import { Marked, type RendererObject } from 'marked';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTable(
  header: { text: string; tokens: any[] }[],
  rows: { text: string; tokens: any[] }[][],
  cellRenderer: (cell: { text: string; tokens: any[] }) => string,
): string {
  const allRows = [
    header.map((c) => cellRenderer(c)),
    ...rows.map((r) => r.map((c) => cellRenderer(c))),
  ];
  const colWidths = header.map((_, i) =>
    Math.max(...allRows.map((r) => r[i].length)),
  );
  return allRows
    .map((row) => row.map((cell, i) => cell.padEnd(colWidths[i])).join('  '))
    .join('\n');
}

function formatListItem(prefix: string, body: string, indent: string): string {
  const trimmed = body.replace(/\n$/, '');
  const lines = trimmed.split('\n');
  const first = lines[0];
  if (lines.length === 1) {
    return prefix + first + '\n';
  }
  const rest = lines
    .slice(1)
    .map((line) => indent + line)
    .join('\n');
  return prefix + first + '\n' + rest + '\n';
}

export const TelegramHtmlRenderer: RendererObject = {
  strong({ tokens }) {
    return '<b>' + this.parser.parseInline(tokens) + '</b>';
  },
  em({ tokens }) {
    return '<i>' + this.parser.parseInline(tokens) + '</i>';
  },
  del({ tokens }) {
    return '<s>' + this.parser.parseInline(tokens) + '</s>';
  },
  codespan({ text }) {
    return '<code>' + escapeHtml(text) + '</code>';
  },
  code({ text, lang }) {
    const cls = lang ? ` class="language-${lang}"` : '';
    return '<pre><code' + cls + '>' + escapeHtml(text) + '</code></pre>\n';
  },
  heading({ tokens }) {
    return '<b>' + this.parser.parseInline(tokens) + '</b>\n\n';
  },
  blockquote({ tokens }) {
    const body = this.parser.parse(tokens).trim();
    return '<blockquote>' + body + '</blockquote>\n';
  },
  hr() {
    return '\u2014\u2014\u2014\n';
  },
  list(token) {
    let result = '';
    for (let i = 0; i < token.items.length; i++) {
      const item = token.items[i];
      const body = this.parser.parse(item.tokens);
      if (token.ordered) {
        const start = typeof token.start === 'number' ? token.start : 1;
        const prefix = start + i + '. ';
        result += formatListItem(prefix, body, '   ');
      } else {
        result += formatListItem('- ', body, '  ');
      }
    }
    return result;
  },
  paragraph({ tokens }) {
    return this.parser.parseInline(tokens) + '\n';
  },
  link({ href, tokens }) {
    return (
      '<a href="' +
      escapeHtml(href) +
      '">' +
      this.parser.parseInline(tokens) +
      '</a>'
    );
  },
  image({ href, text }) {
    return escapeHtml(text) + ' (' + href + ')';
  },
  table(token) {
    const content = renderTable(token.header, token.rows, (c) => c.text);
    return '<pre>' + escapeHtml(content) + '</pre>\n';
  },
  text(token) {
    if ('tokens' in token && token.tokens) {
      return this.parser.parseInline(token.tokens) + '\n';
    }
    return escapeHtml(token.text);
  },
  br() {
    return '\n';
  },
  html({ text }) {
    return escapeHtml(text);
  },
  space() {
    return '\n';
  },
  def() {
    return '';
  },
  checkbox({ checked }) {
    return checked ? '[x] ' : '[ ] ';
  },
};

export const WhatsAppRenderer: RendererObject = {
  strong({ tokens }) {
    return '*' + this.parser.parseInline(tokens) + '*';
  },
  em({ tokens }) {
    return '_' + this.parser.parseInline(tokens) + '_';
  },
  del({ tokens }) {
    return '~' + this.parser.parseInline(tokens) + '~';
  },
  codespan({ text }) {
    return '`' + text + '`';
  },
  code({ text }) {
    return '```' + text + '```\n';
  },
  heading({ tokens }) {
    return '*' + this.parser.parseInline(tokens) + '*\n\n';
  },
  blockquote({ tokens }) {
    const body = this.parser.parse(tokens).trim();
    return (
      body
        .split('\n')
        .map((line: string) => '> ' + line)
        .join('\n') + '\n'
    );
  },
  hr() {
    return '\u2014\u2014\u2014\n';
  },
  list(token) {
    let result = '';
    for (let i = 0; i < token.items.length; i++) {
      const item = token.items[i];
      const body = this.parser.parse(item.tokens);
      if (token.ordered) {
        const start = typeof token.start === 'number' ? token.start : 1;
        const prefix = start + i + '. ';
        result += formatListItem(prefix, body, '   ');
      } else {
        result += formatListItem('- ', body, '  ');
      }
    }
    return result;
  },
  paragraph({ tokens }) {
    return this.parser.parseInline(tokens) + '\n';
  },
  link({ href, tokens }) {
    const text = this.parser.parseInline(tokens);
    return text + ' (' + href + ')';
  },
  image({ href, text }) {
    return text + ' (' + href + ')';
  },
  table(token) {
    const content = renderTable(token.header, token.rows, (c) =>
      this.parser.parseInline(c.tokens),
    );
    return content + '\n';
  },
  text(token) {
    if ('tokens' in token && token.tokens) {
      return this.parser.parseInline(token.tokens) + '\n';
    }
    return token.text;
  },
  br() {
    return '\n';
  },
  html({ text }) {
    return text;
  },
  space() {
    return '\n';
  },
  def() {
    return '';
  },
  checkbox({ checked }) {
    return checked ? '[x] ' : '[ ] ';
  },
};

export const PlainTextRenderer: RendererObject = {
  strong({ tokens }) {
    return this.parser.parseInline(tokens);
  },
  em({ tokens }) {
    return this.parser.parseInline(tokens);
  },
  del({ tokens }) {
    return this.parser.parseInline(tokens);
  },
  codespan({ text }) {
    return text;
  },
  code({ text }) {
    return text + '\n';
  },
  heading({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const emoji = depth === 1 ? '◆' : depth === 2 ? '▸' : '•';
    return `${emoji} ${text}\n\n`;
  },
  blockquote({ tokens }) {
    return this.parser.parse(tokens).trim() + '\n';
  },
  hr() {
    return '---\n';
  },
  list(token) {
    let result = '';
    for (let i = 0; i < token.items.length; i++) {
      const item = token.items[i];
      const body = this.parser.parse(item.tokens);
      if (token.ordered) {
        const start = typeof token.start === 'number' ? token.start : 1;
        result += formatListItem(`${start + i}. `, body, '   ');
      } else {
        result += formatListItem('- ', body, '  ');
      }
    }
    return result;
  },
  paragraph({ tokens }) {
    return this.parser.parseInline(tokens) + '\n';
  },
  link({ href, tokens }) {
    const text = this.parser.parseInline(tokens);
    return text === href ? href : `${text} (${href})`;
  },
  image({ text }) {
    return text;
  },
  table(token) {
    return (
      renderTable(token.header, token.rows, (c) =>
        this.parser.parseInline(c.tokens),
      ) + '\n'
    );
  },
  text(token) {
    if ('tokens' in token && token.tokens)
      return this.parser.parseInline(token.tokens) + '\n';
    return token.text;
  },
  br() {
    return '\n';
  },
  html() {
    return '';
  },
  space() {
    return '\n';
  },
  def() {
    return '';
  },
  checkbox({ checked }) {
    return checked ? '[x] ' : '[ ] ';
  },
};

export function renderMarkdown(
  markdown: string,
  renderer: RendererObject,
): string {
  try {
    const m = new Marked({ renderer });
    const result = m.parse(markdown) as string;
    return result.replace(/^\n+/, '').replace(/\n+$/, '');
  } catch {
    return markdown.trim();
  }
}

// Splits markdown into top-level blocks suitable for independent rendering.
// Blocks are separated by blank lines. Fenced code blocks are kept atomic.
export function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fm = line.match(/^(```+|~~~+)/);
    if (fm && !fence) {
      fence = fm[1];
      cur.push(line);
    } else if (fm && fence && line.startsWith(fence)) {
      fence = null;
      cur.push(line);
    } else if (!fence && line.trim() === '') {
      if (cur.length) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks;
}

// Chunks rendered HTML for delivery channels that cap message length but
// reject malformed entities (e.g. Telegram's 4096-char limit). Renders each
// markdown block independently so HTML tags never straddle chunk boundaries.
// Falls back to plain text only for individual blocks that exceed `max` on
// their own, leaving the rest of the message richly formatted.
export function chunkMarkdownForChannel(
  markdown: string,
  max: number,
  htmlRenderer: RendererObject,
  plainRenderer: RendererObject,
): string[] {
  const full = renderMarkdown(markdown, htmlRenderer);
  if (full.length <= max) return [full];

  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
  };
  for (const block of splitMarkdownBlocks(markdown)) {
    const rendered = renderMarkdown(block, htmlRenderer);
    if (rendered.length > max) {
      flush();
      const plain = renderMarkdown(block, plainRenderer);
      for (let i = 0; i < plain.length; i += max) {
        chunks.push(plain.slice(i, i + max));
      }
      continue;
    }
    const candidate = cur ? cur + '\n\n' + rendered : rendered;
    if (candidate.length <= max) {
      cur = candidate;
    } else {
      flush();
      cur = rendered;
    }
  }
  flush();
  return chunks;
}
