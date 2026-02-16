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

function formatListItem(
  prefix: string,
  body: string,
  indent: string,
): string {
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
    return '<b>' + this.parser.parseInline(tokens) + '</b>\n';
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
        const start =
          typeof token.start === 'number' ? token.start : 1;
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
    return '<a href="' + escapeHtml(href) + '">' + this.parser.parseInline(tokens) + '</a>';
  },
  image({ href, text }) {
    return escapeHtml(text) + ' (' + href + ')';
  },
  table(token) {
    const content = renderTable(
      token.header,
      token.rows,
      (c) => c.text,
    );
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
    return '';
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
    return '*' + this.parser.parseInline(tokens) + '*\n';
  },
  blockquote({ tokens }) {
    const body = this.parser.parse(tokens).trim();
    return body
      .split('\n')
      .map((line: string) => '> ' + line)
      .join('\n') + '\n';
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
        const start =
          typeof token.start === 'number' ? token.start : 1;
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
    const content = renderTable(
      token.header,
      token.rows,
      (c) => this.parser.parseInline(c.tokens),
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
    return '';
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
    return result.replace(/\n$/, '');
  } catch {
    return markdown.trim();
  }
}
