import { Marked, type RendererObject } from 'marked';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderTable(
  header: { text: string; tokens: any[] }[],
  rows: { text: string; tokens: any[] }[][],
  parseInline: (tokens: any[]) => string,
): string {
  const allRows = [
    header.map((c) => parseInline(c.tokens)),
    ...rows.map((r) => r.map((c) => parseInline(c.tokens))),
  ];
  const colWidths = header.map((_, i) =>
    Math.max(...allRows.map((r) => r[i].length)),
  );
  return allRows
    .map((row) => row.map((cell, i) => cell.padEnd(colWidths[i])).join('  '))
    .join('\n');
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
      const text = this.parser.parse(item.tokens).trim();
      if (token.ordered) {
        const start =
          typeof token.start === 'number' ? token.start : 1;
        result += start + i + '. ' + text + '\n';
      } else {
        result += '- ' + text + '\n';
      }
    }
    return result;
  },
  paragraph({ tokens }) {
    return this.parser.parseInline(tokens) + '\n';
  },
  link({ href, tokens }) {
    return '<a href="' + href + '">' + this.parser.parseInline(tokens) + '</a>';
  },
  image({ href, text }) {
    return escapeHtml(text) + ' (' + href + ')';
  },
  table(token) {
    const content = renderTable(
      token.header,
      token.rows,
      (t) => this.parser.parseInline(t),
    );
    return '<pre>' + escapeHtml(content) + '</pre>\n';
  },
  text(token) {
    if ('tokens' in token && token.tokens) {
      return this.parser.parseInline(token.tokens);
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
      const text = this.parser.parse(item.tokens).trim();
      if (token.ordered) {
        const start =
          typeof token.start === 'number' ? token.start : 1;
        result += start + i + '. ' + text + '\n';
      } else {
        result += '- ' + text + '\n';
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
      (t) => this.parser.parseInline(t),
    );
    return content + '\n';
  },
  text(token) {
    if ('tokens' in token && token.tokens) {
      return this.parser.parseInline(token.tokens);
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
