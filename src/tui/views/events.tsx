import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { ListView } from '../components/list-view.js';
import { DetailPanel } from '../components/detail-panel.js';
import { StatusBar } from '../components/status-bar.js';
import type { ViewProps } from '../app.js';
import * as data from '../data.js';
import type { EventRecord } from '../../types.js';
import type { HandlerRunLog } from '../../types.js';

export function EventsView({ listHeight, detailHeight }: ViewProps) {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [logs, setLogs] = useState<HandlerRunLog[]>([]);
  const [selected, setSelected] = useState(0);
  const [focusDetail, setFocusDetail] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [activeFilter, setActiveFilter] = useState('');

  const refresh = useCallback(() => {
    try {
      if (activeFilter) {
        setEvents(data.getEventsByType(activeFilter));
      } else {
        setEvents(data.getRecentEvents());
      }
      setLogs(data.getRecentHandlerLogs());
    } catch {
      setEvents([]);
      setLogs([]);
    }
  }, [activeFilter]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  useInput(
    (input, key) => {
      if (filtering) {
        if (key.return) {
          setActiveFilter(filterText);
          setFiltering(false);
          setSelected(0);
        } else if (key.escape) {
          setFiltering(false);
          setFilterText(activeFilter);
        }
        return;
      }

      if (input === '/') {
        setFiltering(true);
        setFilterText(activeFilter);
      } else if (key.tab) {
        if (key.shift) {
          setFocusDetail((f) => !f);
        } else {
          setShowLogs((s) => !s);
          setSelected(0);
        }
      } else if (input === 'c' && activeFilter) {
        setActiveFilter('');
        setFilterText('');
        setSelected(0);
      }
    },
    { isActive: !filtering },
  );

  if (showLogs) {
    const log = logs[selected];
    const logContent = log
      ? [
          `**Handler:** ${log.handler_id}`,
          `**Event ID:** ${log.event_id}`,
          `**Run At:** ${log.run_at}`,
          `**Duration:** ${log.duration_ms}ms`,
          `**Status:** ${log.status}`,
          '',
          log.status === 'error'
            ? `**Error:**\n\`\`\`\n${log.error}\n\`\`\``
            : `**Result:** ${log.result || '(none)'}`,
        ].join('\n')
      : '';

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" height={listHeight}>
          <ListView
            items={logs}
            selected={selected}
            onSelect={setSelected}
            height={listHeight}
            isFocused={!focusDetail}
            renderItem={(l, _i, isSel) => (
              <Box gap={1}>
                <Text inverse={isSel}>{isSel ? '>' : ' '}</Text>
                <Text color={l.status === 'error' ? 'red' : 'green'} bold={isSel}>
                  [{l.status === 'error' ? 'ERR' : ' OK'}]
                </Text>
                <Text bold={isSel} wrap="truncate">
                  {l.handler_id.length > 20 ? l.handler_id.slice(0, 20) + '...' : l.handler_id}
                </Text>
                <Text dimColor>{l.duration_ms}ms</Text>
                <Text dimColor>{l.run_at.slice(0, 19)}</Text>
              </Box>
            )}
          />
        </Box>
        <DetailPanel
          title="Log Details"
          content={logContent}
          height={detailHeight}
          isFocused={focusDetail}
        />
        <StatusBar
          keys={[
            { key: 'j/k', label: 'Navigate' },
            { key: 'Tab', label: 'Events' },
            { key: 'S-Tab', label: 'Focus' },
          ]}
        />
      </Box>
    );
  }

  const event = events[selected];
  let formattedPayload = '';
  if (event) {
    try {
      formattedPayload = JSON.stringify(JSON.parse(event.payload), null, 2);
    } catch {
      formattedPayload = event.payload;
    }
  }
  const eventContent = event
    ? [
        `**ID:** ${event.id}`,
        `**Type:** ${event.type}`,
        `**Emitted:** ${event.emitted_at}`,
        `**Processed:** ${event.processed ? 'Yes' : 'No'}`,
        '',
        '### Payload',
        '```',
        formattedPayload,
        '```',
      ].join('\n')
    : '';

  return (
    <Box flexDirection="column">
      {filtering && (
        <Box>
          <Text bold>Filter by type: </Text>
          <TextInput value={filterText} onChange={setFilterText} />
        </Box>
      )}
      {activeFilter && !filtering && (
        <Box>
          <Text dimColor>Filtered: "{activeFilter}" (c to clear)</Text>
        </Box>
      )}
      <Box flexDirection="column" height={listHeight}>
        <ListView
          items={events}
          selected={selected}
          onSelect={setSelected}
          height={listHeight}
          isFocused={!focusDetail && !filtering}
          renderItem={(e, _i, isSel) => (
            <Box gap={1}>
              <Text inverse={isSel}>{isSel ? '>' : ' '}</Text>
              <Text dimColor>#{e.id}</Text>
              <Text bold={isSel}>{e.type}</Text>
              <Text color={e.processed ? 'green' : 'yellow'}>
                {e.processed ? '[done]' : '[pend]'}
              </Text>
              <Text dimColor>{e.emitted_at.slice(0, 19)}</Text>
            </Box>
          )}
        />
      </Box>
      <DetailPanel
        title={event ? `Event #${event.id}` : 'Event Details'}
        content={eventContent}
        height={detailHeight}
        isFocused={focusDetail}
      />
      <StatusBar
        keys={[
          { key: 'j/k', label: 'Navigate' },
          { key: '/', label: 'Filter' },
          { key: 'Tab', label: 'Logs' },
          { key: 'S-Tab', label: 'Focus' },
        ]}
      />
    </Box>
  );
}
