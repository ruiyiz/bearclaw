import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

import { ListView } from '../components/list-view.js';
import { DetailPanel } from '../components/detail-panel.js';
import { StatusBar } from '../components/status-bar.js';
import type { ViewProps } from '../app.js';
import { getRegisteredAgents } from '../data.js';
import type { RegisteredAgent } from '../../types.js';
import { AGENTS_DIR } from '../../config.js';

import fs from 'fs';
import path from 'path';

export function AgentsView({ listHeight, detailHeight }: ViewProps) {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [selected, setSelected] = useState(0);
  const [focusDetail, setFocusDetail] = useState(false);

  useEffect(() => {
    setAgents(getRegisteredAgents());
  }, []);

  useInput((_, key) => {
    if (key.tab) setFocusDetail((f) => !f);
  });

  const agent = agents[selected];

  let detailContent = '';
  if (agent) {
    const lines: string[] = [
      `**Name:** ${agent.name}`,
      `**Folder:** ${agent.folder}`,
      `**Trigger:** ${agent.trigger || '(none)'}`,
      `**Added:** ${agent.added_at}`,
    ];

    if (agent.containerConfig) {
      lines.push('', '### Container');
      lines.push(`**Timeout:** ${agent.containerConfig.timeout || 300000}ms`);
    }

    if (agent.odyssey) {
      lines.push('', '### Odyssey');
      lines.push(`**Interval:** ${agent.odyssey.interval}`);
      if (agent.odyssey.model) lines.push(`**Model:** ${agent.odyssey.model}`);
      if (agent.odyssey.quiet) {
        lines.push(`**Quiet:** ${agent.odyssey.quiet.start} - ${agent.odyssey.quiet.end}`);
      }
    }

    if (agent.email) {
      lines.push('', '### Email');
      lines.push(`**Address:** ${agent.email.address}`);
      lines.push(`**Interval:** ${agent.email.interval || '1h'}`);
    }

    const identityMd = path.join(AGENTS_DIR, agent.folder, 'IDENTITY.md');
    try {
      const stat = fs.statSync(identityMd);
      lines.push('', `**IDENTITY.md:** ${identityMd} (${(stat.size / 1024).toFixed(1)}KB)`);
    } catch {
      lines.push('', '**IDENTITY.md:** not found');
    }

    detailContent = lines.join('\n');
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={listHeight}>
        <ListView
          items={agents}
          selected={selected}
          onSelect={setSelected}
          height={listHeight}
          isFocused={!focusDetail}
          renderItem={(a, _i, isSel) => (
            <Box gap={1}>
              <Text inverse={isSel}>{isSel ? '>' : ' '}</Text>
              <Text bold={isSel}>{a.name}</Text>
              <Text dimColor>({a.folder})</Text>
            </Box>
          )}
        />
      </Box>
      <DetailPanel
        title={agent ? agent.name : 'Agent Details'}
        content={detailContent}
        height={detailHeight}
        isFocused={focusDetail}
      />
      <StatusBar
        keys={[
          { key: 'j/k', label: 'Navigate' },
          { key: 'Tab', label: 'Focus' },
        ]}
      />
    </Box>
  );
}
