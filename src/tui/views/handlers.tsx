import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

import { ListView } from '../components/list-view.js';
import { DetailPanel } from '../components/detail-panel.js';
import { StatusBar } from '../components/status-bar.js';
import type { ViewProps } from '../app.js';
import * as data from '../data.js';
import type { Handler } from '../../types.js';

const STATUS_COLORS = {
  active: 'green',
  paused: 'yellow',
  completed: 'gray',
} as const;

export function HandlersView({ listHeight, detailHeight }: ViewProps) {
  const [handlers, setHandlers] = useState<Handler[]>([]);
  const [selected, setSelected] = useState(0);
  const [focusDetail, setFocusDetail] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(() => {
    try {
      setHandlers(data.getAllHandlers());
    } catch {
      setHandlers([]);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  useInput((input, key) => {
    if (confirmDelete) {
      if (input === 'y' && handlers[selected]) {
        data.deleteHandler(handlers[selected].id);
        setConfirmDelete(false);
        refresh();
        setSelected((s) => Math.min(s, handlers.length - 2));
      } else {
        setConfirmDelete(false);
      }
      return;
    }

    if (key.tab) {
      setFocusDetail((f) => !f);
    } else if (!focusDetail && handlers[selected]) {
      const h = handlers[selected];
      if (input === 'p' && h.status === 'active') {
        data.pauseHandler(h.id);
        refresh();
      } else if (input === 'r' && h.status === 'paused') {
        data.resumeHandler(h.id);
        refresh();
      } else if (input === 'd') {
        setConfirmDelete(true);
      }
    }
  });

  const handler = handlers[selected];
  const detailContent = handler
    ? [
        `**ID:** ${handler.id}`,
        `**Agent:** ${handler.group_folder}`,
        `**Event:** ${handler.event_type}`,
        `**Status:** ${handler.status}`,
        `**Context:** ${handler.context_mode}`,
        `**Cron:** ${handler.cron || '(none)'}`,
        `**Next Run:** ${handler.next_run || '(none)'}`,
        `**Cooldown:** ${handler.cooldown_ms}ms`,
        `**Triggers:** ${handler.trigger_count}${handler.max_triggers ? `/${handler.max_triggers}` : ''}`,
        `**Last Triggered:** ${handler.last_triggered || 'never'}`,
        `**Created:** ${handler.created_at}`,
        `**Filter:** ${handler.filter || '(none)'}`,
        '',
        '### Prompt',
        handler.prompt,
      ].join('\n')
    : '';

  return (
    <Box flexDirection="column">
      {confirmDelete && (
        <Box>
          <Text color="red" bold>
            Delete handler "{handler?.id}"? [y/N]
          </Text>
        </Box>
      )}
      <Box flexDirection="column" height={listHeight}>
        <ListView
          items={handlers}
          selected={selected}
          onSelect={setSelected}
          height={listHeight}
          isFocused={!focusDetail}
          renderItem={(h, _i, isSel) => (
            <Box gap={1}>
              <Text inverse={isSel}>
                {isSel ? '>' : ' '}
              </Text>
              <Text
                color={STATUS_COLORS[h.status] || 'white'}
                bold={isSel}
              >
                [{h.status.slice(0, 3).toUpperCase()}]
              </Text>
              <Text bold={isSel} wrap="truncate">
                {h.id.length > 24 ? h.id.slice(0, 24) + '...' : h.id}
              </Text>
              <Text dimColor>{h.event_type}</Text>
              <Text dimColor>({h.group_folder})</Text>
            </Box>
          )}
        />
      </Box>
      <DetailPanel
        title={handler ? handler.id : 'Handler Details'}
        content={detailContent}
        height={detailHeight}
        isFocused={focusDetail}
      />
      <StatusBar
        keys={[
          { key: 'j/k', label: 'Navigate' },
          { key: 'Tab', label: 'Focus' },
          { key: 'p', label: 'Pause' },
          { key: 'r', label: 'Resume' },
          { key: 'd', label: 'Delete' },
        ]}
      />
    </Box>
  );
}
