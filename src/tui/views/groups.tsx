import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

import { ListView } from '../components/list-view.js';
import { DetailPanel } from '../components/detail-panel.js';
import { StatusBar } from '../components/status-bar.js';
import type { ViewProps } from '../app.js';
import { getRegisteredGroups } from '../data.js';
import type { RegisteredGroup } from '../../types.js';
import { GROUPS_DIR } from '../../config.js';

import fs from 'fs';
import path from 'path';

export function GroupsView({ listHeight, detailHeight }: ViewProps) {
  const [groups, setGroups] = useState<RegisteredGroup[]>([]);
  const [selected, setSelected] = useState(0);
  const [focusDetail, setFocusDetail] = useState(false);

  useEffect(() => {
    setGroups(getRegisteredGroups());
  }, []);

  useInput((_, key) => {
    if (key.tab) setFocusDetail((f) => !f);
  });

  const group = groups[selected];

  let detailContent = '';
  if (group) {
    const lines: string[] = [
      `**Name:** ${group.name}`,
      `**Folder:** ${group.folder}`,
      `**Trigger:** ${group.trigger || '(none)'}`,
      `**Added:** ${group.added_at}`,
    ];

    if (group.containerConfig) {
      lines.push('', '### Container');
      lines.push(`**Timeout:** ${group.containerConfig.timeout || 300000}ms`);
    }

    if (group.odyssey) {
      lines.push('', '### Odyssey');
      lines.push(`**Interval:** ${group.odyssey.interval}`);
      if (group.odyssey.model) lines.push(`**Model:** ${group.odyssey.model}`);
      if (group.odyssey.quiet) {
        lines.push(`**Quiet:** ${group.odyssey.quiet.start} - ${group.odyssey.quiet.end}`);
      }
    }

    if (group.email) {
      lines.push('', '### Email');
      lines.push(`**Address:** ${group.email.address}`);
      lines.push(`**Interval:** ${group.email.interval || '1h'}`);
    }

    const claudeMd = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
    try {
      const stat = fs.statSync(claudeMd);
      lines.push('', `**CLAUDE.md:** ${claudeMd} (${(stat.size / 1024).toFixed(1)}KB)`);
    } catch {
      lines.push('', '**CLAUDE.md:** not found');
    }

    detailContent = lines.join('\n');
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={listHeight}>
        <ListView
          items={groups}
          selected={selected}
          onSelect={setSelected}
          height={listHeight}
          isFocused={!focusDetail}
          renderItem={(g, _i, isSel) => (
            <Box gap={1}>
              <Text inverse={isSel}>{isSel ? '>' : ' '}</Text>
              <Text bold={isSel}>{g.name}</Text>
              <Text dimColor>({g.folder})</Text>
            </Box>
          )}
        />
      </Box>
      <DetailPanel
        title={group ? group.name : 'Group Details'}
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
