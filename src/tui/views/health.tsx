import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

import type { ViewProps } from '../app.js';
import { runHealthChecks, type HealthCheck } from '../data.js';

const STATUS_COLORS = {
  ok: 'green',
  warn: 'yellow',
  fail: 'red',
} as const;

const STATUS_LABELS = {
  ok: ' OK ',
  warn: 'WARN',
  fail: 'FAIL',
} as const;

export function HealthView({ listHeight, detailHeight }: ViewProps) {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [lastRun, setLastRun] = useState('');

  const refresh = () => {
    try {
      setChecks(runHealthChecks());
    } catch {
      setChecks([{ name: 'Error', status: 'fail', detail: 'Failed to run health checks' }]);
    }
    setLastRun(new Date().toLocaleTimeString());
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  const allOk = checks.every((c) => c.status === 'ok');
  const height = listHeight + detailHeight;

  return (
    <Box flexDirection="column" height={height}>
      <Box marginBottom={1}>
        <Text bold>
          Health Status{' '}
        </Text>
        <Text dimColor>
          (refreshes every 10s, last: {lastRun})
        </Text>
      </Box>

      {checks.map((check, i) => (
        <Box key={i} gap={1}>
          <Text color={STATUS_COLORS[check.status]} bold>
            [{STATUS_LABELS[check.status]}]
          </Text>
          <Text bold>{check.name}</Text>
          <Text dimColor>— {check.detail}</Text>
        </Box>
      ))}

      <Box marginTop={1}>
        {allOk ? (
          <Text color="green" bold>All checks passed</Text>
        ) : (
          <Text color="yellow" bold>Some checks need attention</Text>
        )}
      </Box>
    </Box>
  );
}
