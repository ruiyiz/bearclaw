import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

import { ListView } from '../components/list-view.js';
import { DetailPanel } from '../components/detail-panel.js';
import { StatusBar } from '../components/status-bar.js';
import type { ViewProps } from '../app.js';
import { getRegisteredAgents, getAllHandlers, getHeartbeatLogTail } from '../data.js';
import type { RegisteredAgent, Handler } from '../../types.js';
import { HEARTBEAT_HANDLER_PREFIX } from '../../config.js';

interface HeartbeatAgent {
  agent: RegisteredAgent;
  handler?: Handler;
  status: 'active' | 'paused' | 'no config';
}

const STATUS_COLORS = {
  active: 'green',
  paused: 'yellow',
  'no config': 'gray',
} as const;

export function HeartbeatView({ listHeight, detailHeight }: ViewProps) {
  const [items, setItems] = useState<HeartbeatAgent[]>([]);
  const [selected, setSelected] = useState(0);
  const [focusDetail, setFocusDetail] = useState(false);

  useEffect(() => {
    let agents: RegisteredAgent[];
    let handlers: Handler[];
    try {
      agents = getRegisteredAgents();
    } catch {
      agents = [];
    }
    try {
      handlers = getAllHandlers();
    } catch {
      handlers = [];
    }

    const heartbeatItems: HeartbeatAgent[] = agents.map((a) => {
      const handler = handlers.find(
        (h) => h.id === `${HEARTBEAT_HANDLER_PREFIX}${a.folder}`,
      );

      if (!a.heartbeat) {
        return { agent: a, handler, status: 'no config' as const };
      }

      return {
        agent: a,
        handler,
        status: handler?.status === 'active' ? 'active' : 'paused',
      };
    });

    setItems(heartbeatItems);
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
      `**Agent:** ${item.agent.name}`,
      `**Status:** ${item.status}`,
    ];

    if (item.agent.heartbeat) {
      lines.push('', '### Config');
      lines.push(`**Interval:** ${item.agent.heartbeat.interval}`);
      if (item.agent.heartbeat.model) {
        lines.push(`**Model:** ${item.agent.heartbeat.model}`);
      }
      if (item.agent.heartbeat.quiet) {
        lines.push(
          `**Quiet Hours:** ${item.agent.heartbeat.quiet.start} - ${item.agent.heartbeat.quiet.end}`,
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
    lines.push(getHeartbeatLogTail(item.agent.folder));

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
              <Text bold={isSel}>{o.agent.name}</Text>
              <Text color={STATUS_COLORS[o.status]}>
                [{o.status}]
              </Text>
              {o.agent.heartbeat && (
                <Text dimColor>{o.agent.heartbeat.interval}</Text>
              )}
            </Box>
          )}
        />
      </Box>
      <DetailPanel
        title={item ? `${item.agent.name} — Heartbeat` : 'Heartbeat Details'}
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
