import React, { type ReactNode } from 'react';
import { Box, Text, useStdout } from 'ink';

interface MarkdownProps {
  content: string;
  scrollOffset?: number;
  visibleLines?: number;
}

interface ParsedLine {
  type: 'h1' | 'h2' | 'h3' | 'code' | 'quote' | 'bullet' | 'hr' | 'text' | 'empty';
  content: string;
  indent?: number;
}

function parseLines(text: string): ParsedLine[] {
  const lines = text.split('\n');
  const result: ParsedLine[] = [];
  let inCode = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      result.push({ type: 'code', content: line });
      continue;
    }

    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (!trimmed) {
      result.push({ type: 'empty', content: '' });
    } else if (trimmed.startsWith('### ')) {
      result.push({ type: 'h3', content: trimmed.slice(4) });
    } else if (trimmed.startsWith('## ')) {
      result.push({ type: 'h2', content: trimmed.slice(3) });
    } else if (trimmed.startsWith('# ')) {
      result.push({ type: 'h1', content: trimmed.slice(2) });
    } else if (/^[-*+] /.test(trimmed)) {
      result.push({ type: 'bullet', content: trimmed.slice(2), indent });
    } else if (/^\d+\. /.test(trimmed)) {
      const m = trimmed.match(/^\d+\. /);
      result.push({ type: 'bullet', content: trimmed.slice(m![0].length), indent });
    } else if (trimmed.startsWith('> ')) {
      result.push({ type: 'quote', content: trimmed.slice(2) });
    } else if (/^[-_*]{3,}$/.test(trimmed)) {
      result.push({ type: 'hr', content: '' });
    } else {
      result.push({ type: 'text', content: line, indent });
    }
  }

  return result;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let buf = '';

  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = '';
    }
  };

  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        nodes.push(
          <Text key={key++} color="yellow">
            {text.slice(i + 1, end)}
          </Text>,
        );
        i = end + 1;
        continue;
      }
    }

    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        flush();
        nodes.push(
          <Text key={key++} bold>
            {text.slice(i + 2, end)}
          </Text>,
        );
        i = end + 2;
        continue;
      }
    }

    if (text[i] === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && text[end - 1] !== '*') {
        flush();
        nodes.push(
          <Text key={key++} italic dimColor>
            {text.slice(i + 1, end)}
          </Text>,
        );
        i = end + 1;
        continue;
      }
    }

    buf += text[i];
    i++;
  }
  flush();

  return nodes;
}

function renderLine(line: ParsedLine, key: number, cols: number): ReactNode {
  switch (line.type) {
    case 'h1':
      return (
        <Text key={key} bold color="white">
          {line.content}
        </Text>
      );
    case 'h2':
      return (
        <Text key={key} bold color="blue">
          {line.content}
        </Text>
      );
    case 'h3':
      return (
        <Text key={key} bold dimColor>
          {line.content}
        </Text>
      );
    case 'code':
      return (
        <Text key={key} color="yellow" dimColor>
          {'  '}{line.content}
        </Text>
      );
    case 'quote':
      return (
        <Box key={key}>
          <Text color="gray">{'│ '}</Text>
          <Text dimColor>{renderInline(line.content)}</Text>
        </Box>
      );
    case 'bullet': {
      const pad = ' '.repeat(line.indent || 0);
      return (
        <Text key={key}>
          {pad}{'· '}{renderInline(line.content)}
        </Text>
      );
    }
    case 'hr':
      return (
        <Text key={key} dimColor>
          {'─'.repeat(Math.min(cols, 40))}
        </Text>
      );
    case 'empty':
      return <Text key={key}>{' '}</Text>;
    case 'text':
    default:
      return <Text key={key}>{renderInline(line.content)}</Text>;
  }
}

export function Markdown({ content, scrollOffset = 0, visibleLines }: MarkdownProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const parsed = parseLines(content);
  const sliced = visibleLines
    ? parsed.slice(scrollOffset, scrollOffset + visibleLines)
    : parsed;

  return (
    <Box flexDirection="column">
      {sliced.map((line, i) => renderLine(line, i, cols))}
    </Box>
  );
}

export function getMarkdownLineCount(content: string): number {
  return parseLines(content).length;
}
