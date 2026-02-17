import { describe, it, expect } from 'bun:test';
import {
  TelegramHtmlRenderer,
  WhatsAppRenderer,
  renderMarkdown,
} from './format.js';

describe('renderMarkdown', () => {
  it('returns raw text on malformed input', () => {
    const badRenderer = {
      paragraph() {
        throw new Error('boom');
      },
    };
    const result = renderMarkdown('hello world', badRenderer);
    expect(result).toBe('hello world');
  });
});

describe('TelegramHtmlRenderer', () => {
  const render = (md: string) => renderMarkdown(md, TelegramHtmlRenderer);

  describe('inline formatting', () => {
    it('renders bold', () => {
      expect(render('**bold**')).toBe('<b>bold</b>');
    });

    it('renders italic with asterisks', () => {
      expect(render('*italic*')).toBe('<i>italic</i>');
    });

    it('renders italic with underscores', () => {
      expect(render('_italic_')).toBe('<i>italic</i>');
    });

    it('renders strikethrough', () => {
      expect(render('~~strike~~')).toBe('<s>strike</s>');
    });

    it('renders inline code', () => {
      expect(render('`code`')).toBe('<code>code</code>');
    });

    it('renders nested bold italic', () => {
      expect(render('**_bold italic_**')).toBe('<b><i>bold italic</i></b>');
    });
  });

  describe('block formatting', () => {
    it('renders headings as bold', () => {
      expect(render('# Header')).toBe('<b>Header</b>');
    });

    it('renders h2 as bold', () => {
      expect(render('## Header 2')).toBe('<b>Header 2</b>');
    });

    it('adds blank lines around headings between content', () => {
      const result = render('intro\n\n## Title\n\nbody');
      expect(result).toBe('intro\n\n<b>Title</b>\n\nbody');
    });

    it('renders code blocks with language', () => {
      expect(render('```js\nconst x = 1;\n```')).toBe(
        '<pre><code class="language-js">const x = 1;</code></pre>',
      );
    });

    it('renders code blocks without language', () => {
      expect(render('```\nplain code\n```')).toBe(
        '<pre><code>plain code</code></pre>',
      );
    });

    it('renders blockquotes', () => {
      expect(render('> quoted text')).toBe(
        '<blockquote>quoted text</blockquote>',
      );
    });

    it('renders horizontal rules', () => {
      expect(render('---')).toBe('\u2014\u2014\u2014');
    });
  });

  describe('lists', () => {
    it('renders unordered lists', () => {
      expect(render('- apple\n- banana\n- cherry')).toBe(
        '- apple\n- banana\n- cherry',
      );
    });

    it('renders ordered lists', () => {
      expect(render('1. first\n2. second\n3. third')).toBe(
        '1. first\n2. second\n3. third',
      );
    });

    it('renders nested unordered lists with indentation', () => {
      const md = '- outer\n  - inner';
      const result = render(md);
      expect(result).toContain('- outer');
      expect(result).toContain('  - inner');
      expect(result).not.toBe('- outer- inner');
    });

    it('renders nested ordered lists with indentation', () => {
      const md = '1. outer\n   1. inner';
      const result = render(md);
      expect(result).toContain('1. outer');
      expect(result).toContain('   1. inner');
    });
  });

  describe('links and images', () => {
    it('renders links as HTML anchors', () => {
      expect(render('[click here](https://example.com)')).toBe(
        '<a href="https://example.com">click here</a>',
      );
    });

    it('escapes quotes in link href', () => {
      const result = render('[click](https://example.com/a"b)');
      expect(result).toContain('href="https://example.com/a&quot;b"');
      expect(result).not.toContain('href="https://example.com/a"b"');
    });

    it('renders images as text with URL', () => {
      expect(render('![photo](https://example.com/img.png)')).toBe(
        'photo (https://example.com/img.png)',
      );
    });
  });

  describe('tables', () => {
    it('renders tables as pre-formatted text', () => {
      const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
      const result = render(md);
      expect(result).toContain('<pre>');
      expect(result).toContain('Name');
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
    });

    it('renders table with formatted cells without double-escaping', () => {
      const md = '| Name | Age |\n|------|-----|\n| **Alice** | 30 |';
      const result = render(md);
      expect(result).not.toContain('&lt;b&gt;');
      expect(result).not.toContain('<b>');
      expect(result).toContain('Alice');
    });
  });

  describe('HTML entity escaping', () => {
    it('escapes < > & in plain text', () => {
      expect(render('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    });

    it('escapes entities in inline code', () => {
      expect(render('`<div>&</div>`')).toBe(
        '<code>&lt;div&gt;&amp;&lt;/div&gt;</code>',
      );
    });

    it('escapes entities in code blocks', () => {
      const result = render('```\n<div>&</div>\n```');
      expect(result).toContain('&lt;div&gt;&amp;&lt;/div&gt;');
    });

    it('escapes entities in bold text', () => {
      expect(render('**a & b**')).toBe('<b>a &amp; b</b>');
    });
  });

  describe('plain text passthrough', () => {
    it('passes through plain text', () => {
      expect(render('hello world')).toBe('hello world');
    });

    it('separates paragraphs with blank lines', () => {
      const result = render('paragraph one\n\nparagraph two');
      expect(result).toBe('paragraph one\n\nparagraph two');
    });
  });

  describe('line breaks', () => {
    it('renders line breaks', () => {
      const result = render('line one  \nline two');
      expect(result).toContain('line one');
      expect(result).toContain('line two');
    });
  });
});

describe('WhatsAppRenderer', () => {
  const render = (md: string) => renderMarkdown(md, WhatsAppRenderer);

  describe('inline formatting', () => {
    it('renders bold', () => {
      expect(render('**bold**')).toBe('*bold*');
    });

    it('renders italic with asterisks', () => {
      expect(render('*italic*')).toBe('_italic_');
    });

    it('renders italic with underscores', () => {
      expect(render('_italic_')).toBe('_italic_');
    });

    it('renders strikethrough', () => {
      expect(render('~~strike~~')).toBe('~strike~');
    });

    it('renders inline code', () => {
      expect(render('`code`')).toBe('`code`');
    });

    it('renders nested bold italic', () => {
      expect(render('**_bold italic_**')).toBe('*_bold italic_*');
    });
  });

  describe('block formatting', () => {
    it('renders headings as bold', () => {
      expect(render('# Header')).toBe('*Header*');
    });

    it('renders h2 as bold', () => {
      expect(render('## Header 2')).toBe('*Header 2*');
    });

    it('adds line breaks around headings between content', () => {
      const result = render('intro\n\n## Title\n\nbody');
      expect(result).toBe('intro\n\n*Title*\n\nbody');
    });

    it('renders code blocks without language tag', () => {
      expect(render('```js\nconst x = 1;\n```')).toBe(
        '```const x = 1;```',
      );
    });

    it('renders code blocks without language', () => {
      expect(render('```\nplain code\n```')).toBe('```plain code```');
    });

    it('renders blockquotes', () => {
      const result = render('> quoted text');
      expect(result).toContain('> quoted text');
    });

    it('renders horizontal rules', () => {
      expect(render('---')).toBe('\u2014\u2014\u2014');
    });
  });

  describe('lists', () => {
    it('renders unordered lists', () => {
      expect(render('- apple\n- banana\n- cherry')).toBe(
        '- apple\n- banana\n- cherry',
      );
    });

    it('renders ordered lists', () => {
      expect(render('1. first\n2. second\n3. third')).toBe(
        '1. first\n2. second\n3. third',
      );
    });

    it('renders nested unordered lists with indentation', () => {
      const md = '- outer\n  - inner';
      const result = render(md);
      expect(result).toContain('- outer');
      expect(result).toContain('  - inner');
      expect(result).not.toBe('- outer- inner');
    });

    it('renders nested ordered lists with indentation', () => {
      const md = '1. outer\n   1. inner';
      const result = render(md);
      expect(result).toContain('1. outer');
      expect(result).toContain('   1. inner');
    });
  });

  describe('links and images', () => {
    it('renders links as text with URL', () => {
      expect(render('[click here](https://example.com)')).toBe(
        'click here (https://example.com)',
      );
    });

    it('renders images as text with URL', () => {
      expect(render('![photo](https://example.com/img.png)')).toBe(
        'photo (https://example.com/img.png)',
      );
    });
  });

  describe('tables', () => {
    it('renders tables as aligned plain text', () => {
      const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
      const result = render(md);
      expect(result).toContain('Name');
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
      expect(result).not.toContain('<');
    });
  });

  describe('no escaping needed', () => {
    it('does not escape < > & in plain text', () => {
      expect(render('a < b & c > d')).toContain('a < b & c > d');
    });
  });

  describe('plain text passthrough', () => {
    it('passes through plain text', () => {
      expect(render('hello world')).toBe('hello world');
    });

    it('separates paragraphs with blank lines', () => {
      const result = render('paragraph one\n\nparagraph two');
      expect(result).toBe('paragraph one\n\nparagraph two');
    });
  });
});
