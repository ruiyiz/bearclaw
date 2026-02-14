import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';

import { ListView } from '../components/list-view.js';
import { DetailPanel } from '../components/detail-panel.js';
import { StatusBar } from '../components/status-bar.js';
import type { ViewProps } from '../app.js';
import * as data from '../data.js';

export function SkillsView({ listHeight, detailHeight }: ViewProps) {
  const [installed, setInstalled] = useState<data.SkillInfo[]>([]);
  const [available, setAvailable] = useState<data.SkillInfo[]>([]);
  const [showAvailable, setShowAvailable] = useState(false);
  const [selected, setSelected] = useState(0);
  const [focusDetail, setFocusDetail] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [sourceInput, setSourceInput] = useState('');
  const [detailContent, setDetailContent] = useState('');
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const refresh = useCallback(() => {
    setInstalled(data.getInstalledSkills());
    setAvailable(data.getAvailableSkills());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const items = showAvailable ? available : installed;
  const skill = items[selected];

  useEffect(() => {
    if (skill) {
      setDetailContent(data.readSkillContent(skill.path));
    } else {
      setDetailContent('');
    }
  }, [skill?.path]);

  useInput(
    (input, key) => {
      if (addingSource) {
        if (key.return) {
          if (sourceInput.trim()) {
            data.addSkillSource(sourceInput.trim());
            refresh();
          }
          setAddingSource(false);
          setSourceInput('');
        } else if (key.escape) {
          setAddingSource(false);
          setSourceInput('');
        }
        return;
      }

      if (key.tab && !key.shift) {
        setShowAvailable((s) => !s);
        setSelected(0);
      } else if (key.tab && key.shift) {
        setFocusDetail((f) => !f);
      } else if (input === 'i' && showAvailable && skill && !skill.installed) {
        data.installSkill(skill.path, skill.name);
        refresh();
        setSelected(0);
      } else if (input === 'u' && !showAvailable && skill && skill.installed) {
        data.uninstallSkill(skill.name);
        refresh();
        setSelected((s) => Math.min(s, installed.length - 2));
      } else if (input === 'a') {
        setAddingSource(true);
      }
    },
    { isActive: !addingSource },
  );

  const subTabHeight = 2; // sub-tab row + divider
  const actualListHeight = listHeight - subTabHeight;

  return (
    <Box flexDirection="column">
      {addingSource && (
        <Box>
          <Text bold>Source directory: </Text>
          <TextInput value={sourceInput} onChange={setSourceInput} />
        </Box>
      )}
      <Box flexDirection="column">
        <Box>
          <Text bold inverse={!showAvailable}> Installed ({installed.length}) </Text>
          <Text> </Text>
          <Text bold inverse={showAvailable}> Available ({available.length}) </Text>
        </Box>
        <Text dimColor>{'─'.repeat(cols)}</Text>
      </Box>
      <Box flexDirection="column" height={actualListHeight}>
        <ListView
          items={items}
          selected={selected}
          onSelect={setSelected}
          height={actualListHeight}
          isFocused={!focusDetail && !addingSource}
          renderItem={(s, _i, isSel) => (
            <Box gap={1}>
              <Text inverse={isSel}>{isSel ? '>' : ' '}</Text>
              <Text bold={isSel} color={s.installed ? 'green' : undefined}>
                {s.name}
              </Text>
              <Text dimColor wrap="truncate">
                {s.description.slice(0, 50)}
              </Text>
            </Box>
          )}
        />
      </Box>
      <DetailPanel
        title={skill ? `${skill.name} — SKILL.md` : 'Skill Details'}
        content={detailContent}
        height={detailHeight}
        isFocused={focusDetail}
      />
      <StatusBar
        keys={[
          { key: 'j/k', label: 'Navigate' },
          { key: 'Tab', label: 'Toggle' },
          ...(showAvailable
            ? [{ key: 'i', label: 'Install' }]
            : [{ key: 'u', label: 'Uninstall' }]),
          { key: 'a', label: 'Add Source' },
          { key: 'S-Tab', label: 'Focus' },
        ]}
      />
    </Box>
  );
}
