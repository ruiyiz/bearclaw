import React from 'react';
import { Box, Text, useStdout } from 'ink';

interface KeyHint {
  key: string;
  label: string;
}

interface StatusBarProps {
  keys: KeyHint[];
}

export function StatusBar({ keys }: StatusBarProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(cols)}</Text>
      <Box flexDirection="row" gap={1} paddingX={1}>
        {keys.map((k, i) => (
          <Box key={i} marginRight={1}>
            <Text bold color="yellow">
              {k.key}
            </Text>
            <Text> {k.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
