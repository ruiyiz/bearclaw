import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { Markdown, getMarkdownLineCount } from './markdown.js';

interface DetailPanelProps {
  title: string;
  content: string;
  height: number;
  isFocused?: boolean;
}

export function DetailPanel({
  title,
  content,
  height,
  isFocused = false,
}: DetailPanelProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const [scrollOffset, setScrollOffset] = useState(0);
  const contentHeight = Math.max(1, height - 2); // title + separator
  const totalLines = getMarkdownLineCount(content);

  useEffect(() => {
    setScrollOffset(0);
  }, [title, content]);

  useInput(
    (input, key) => {
      const maxScroll = Math.max(0, totalLines - contentHeight);
      if (key.pageDown) {
        setScrollOffset((o) => Math.min(o + contentHeight, maxScroll));
      } else if (key.pageUp) {
        setScrollOffset((o) => Math.max(o - contentHeight, 0));
      } else if (input === 'j' || key.downArrow) {
        setScrollOffset((o) => Math.min(o + 1, maxScroll));
      } else if (input === 'k' || key.upArrow) {
        setScrollOffset((o) => Math.max(o - 1, 0));
      } else if (input === 'G') {
        setScrollOffset(maxScroll);
      } else if (input === 'g') {
        setScrollOffset(0);
      }
    },
    { isActive: isFocused },
  );

  const showScrollHint = totalLines > contentHeight;

  return (
    <Box flexDirection="column" height={height}>
      <Text dimColor>{'─'.repeat(cols)}</Text>
      <Box paddingX={1}>
        <Text bold color={isFocused ? 'cyan' : 'white'}>
          {title}
        </Text>
        {showScrollHint && (
          <Text dimColor>
            {' '}({scrollOffset + 1}-{Math.min(scrollOffset + contentHeight, totalLines)}/{totalLines})
          </Text>
        )}
      </Box>
      <Box flexDirection="column" paddingX={1} height={contentHeight}>
        <Markdown
          content={content}
          scrollOffset={scrollOffset}
          visibleLines={contentHeight}
        />
      </Box>
    </Box>
  );
}
