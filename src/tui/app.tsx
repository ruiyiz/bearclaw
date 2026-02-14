import React, { useState } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';

import { TabBar, type Tab } from './components/tab-bar.js';
import { SkillsView } from './views/skills.js';
import { EventsView } from './views/events.js';
import { HandlersView } from './views/handlers.js';
import { GroupsView } from './views/groups.js';
import { HealthView } from './views/health.js';
import { OdysseyView } from './views/odyssey.js';

export interface ViewProps {
  listHeight: number;
  detailHeight: number;
}

const TABS: Tab[] = [
  { key: 'skills', label: 'Skills', shortcut: '1' },
  { key: 'events', label: 'Events', shortcut: '2' },
  { key: 'handlers', label: 'Handlers', shortcut: '3' },
  { key: 'groups', label: 'Groups', shortcut: '4' },
  { key: 'health', label: 'Health', shortcut: '5' },
  { key: 'odyssey', label: 'Odyssey', shortcut: '6' },
];

const TAB_CHROME = 2; // tab bar + separator
const STATUS_CHROME = 2; // separator + key hints

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [activeTab, setActiveTab] = useState('skills');
  const rows = stdout?.rows ?? 24;

  const viewSpace = rows - TAB_CHROME - STATUS_CHROME;
  const listHeight = Math.floor(viewSpace * 0.4);
  const detailHeight = viewSpace - listHeight;

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    const num = parseInt(input, 10);
    if (num >= 1 && num <= TABS.length) {
      setActiveTab(TABS[num - 1].key);
    }
  });

  const props: ViewProps = { listHeight, detailHeight };

  const renderView = () => {
    switch (activeTab) {
      case 'skills':
        return <SkillsView {...props} />;
      case 'events':
        return <EventsView {...props} />;
      case 'handlers':
        return <HandlersView {...props} />;
      case 'groups':
        return <GroupsView {...props} />;
      case 'health':
        return <HealthView {...props} />;
      case 'odyssey':
        return <OdysseyView {...props} />;
      default:
        return null;
    }
  };

  return (
    <Box flexDirection="column" height={rows}>
      <TabBar tabs={TABS} activeTab={activeTab} />
      <Box flexGrow={1} flexDirection="column">
        {renderView()}
      </Box>
    </Box>
  );
}
