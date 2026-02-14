import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

import { ListView } from '../components/list-view.js';
import { DetailPanel } from '../components/detail-panel.js';
import { StatusBar } from '../components/status-bar.js';
import type { ViewProps } from '../app.js';
import { getRegisteredGroups, getAllHandlers, getOdysseyLogTail } from '../data.js';
import type { RegisteredGroup, Handler } from '../../types.js';
import { ODYSSEY_HANDLER_PREFIX } from '../../config.js';

interface OdysseyGroup {
  group: RegisteredGroup;
  handler?: Handler;
  status: 'active' | 'paused' | 'no config';
}

const STATUS_COLORS = {
  active: 'green',
  paused: 'yellow',
  'no config': 'gray',
} as const;

export function OdysseyView({ listHeight, detailHeight }: ViewProps) {
  const [items, setItems] = useState<OdysseyGroup[]>([]);
  const [selected, setSelected] = useState(0);
  const [focusDetail, setFocusDetail] = useState(false);

  useEffect(() => {
    let groups: RegisteredGroup[];
    let handlers: Handler[];
    try {
      groups = getRegisteredGroups();
    } catch {
      groups = [];
    }
    try {
      handlers = getAllHandlers();
    } catch {
      handlers = [];
    }

    const odysseyItems: OdysseyGroup[] = groups.map((g) => {
      const handler = handlers.find(
        (h) => h.id === `${ODYSSEY_HANDLER_PREFIX}${g.folder}`,
      );

      if (!g.odyssey) {
        return { group: g, handler, status: 'no config' as const };
      }

      return {
        group: g,
        handler,
        status: handler?.status === 'active' ? 'active' : 'paused',
      };
    });

    setItems(odysseyItems);
  }, []);

  useInput((_, key) => {
    if (key.tab) {
      setFocusDetail((f) => !f);
    }
  });

  const item = items[selected];
  let detailContent = '';

  if (item) {
    const lines: string[] = [
      `**Group:** ${item.group.name}`,
      `**Status:** ${item.status}`,
    ];

    if (item.group.odyssey) {
      lines.push('', '### Config');
      lines.push(`**Interval:** ${item.group.odyssey.interval}`);
      if (item.group.odyssey.model) {
        lines.push(`**Model:** ${item.group.odyssey.model}`);
      }
      if (item.group.odyssey.quiet) {
        lines.push(
          `**Quiet Hours:** ${item.group.odyssey.quiet.start} - ${item.group.odyssey.quiet.end}`,
        );
      }
    }

    if (item.handler) {
      lines.push('', '### Handler');
      lines.push(`**ID:** ${item.handler.id}`);
      lines.push(`**Cron:** ${item.handler.cron || '(none)'}`);
      lines.push(`**Next Run:** ${item.handler.next_run || '(none)'}`);
      lines.push(`**Triggers:** ${item.handler.trigger_count}`);
      lines.push(`**Last:** ${item.handler.last_triggered || 'never'}`);
    }

    lines.push('', '### Recent Log');
    lines.push(getOdysseyLogTail(item.group.folder));

    detailContent = lines.join('\n');
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={listHeight}>
        <ListView
          items={items}
          selected={selected}
          onSelect={setSelected}
          height={listHeight}
          isFocused={!focusDetail}
          renderItem={(o, _i, isSel) => (
            <Box gap={1}>
              <Text inverse={isSel}>{isSel ? '>' : ' '}</Text>
              <Text bold={isSel}>{o.group.name}</Text>
              <Text color={STATUS_COLORS[o.status]}>
                [{o.status}]
              </Text>
              {o.group.odyssey && (
                <Text dimColor>{o.group.odyssey.interval}</Text>
              )}
            </Box>
          )}
        />
      </Box>
      <DetailPanel
        title={item ? `${item.group.name} — Odyssey` : 'Odyssey Details'}
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
