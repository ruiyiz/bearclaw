import React from 'react';
import { Box, Text, useStdout } from 'ink';

export interface Tab {
  key: string;
  label: string;
  shortcut: string;
}

interface TabBarProps {
  tabs: Tab[];
  activeTab: string;
}

export function TabBar({ tabs, activeTab }: TabBarProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2} paddingX={1}>
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab;
          return isActive ? (
            <Text key={tab.key} backgroundColor="blue" color="white" bold>
              {` ${tab.shortcut}) ${tab.label} `}
            </Text>
          ) : (
            <Text key={tab.key} dimColor>
              {tab.shortcut}) {tab.label}
            </Text>
          );
        })}
      </Box>
      <Text dimColor>{'─'.repeat(cols)}</Text>
    </Box>
  );
}
