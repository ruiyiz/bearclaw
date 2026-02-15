import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';

import { ListView } from '../components/list-view.js';
import { DetailPanel } from '../components/detail-panel.js';
import { StatusBar } from '../components/status-bar.js';
import type { ViewProps } from '../app.js';
import * as data from '../data.js';

type SkillListItem =
  | { type: 'header'; label: string }
  | { type: 'skill'; skill: data.SkillInfo };

const ITEM_HEIGHT = 3;

export function SkillsView({ listHeight, detailHeight }: ViewProps) {
  const [installed, setInstalled] = useState<data.SkillInfo[]>([]);
  const [available, setAvailable] = useState<data.SkillInfo[]>([]);
  const [showAvailable, setShowAvailable] = useState(false);
  const [installedSel, setInstalledSel] = useState(0);
  const [availableSel, setAvailableSel] = useState(0);
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

  const installedItems: SkillListItem[] = useMemo(
    () => installed.map((s) => ({ type: 'skill' as const, skill: s })),
    [installed],
  );

  const availableItems: SkillListItem[] = useMemo(() => {
    const items: SkillListItem[] = [];
    let lastSource = '';
    for (const skill of available) {
      if (skill.source !== lastSource) {
        items.push({ type: 'header', label: skill.source });
        lastSource = skill.source;
      }
      items.push({ type: 'skill', skill });
    }
    return items;
  }, [available]);

  const items = showAvailable ? availableItems : installedItems;
  const selected = showAvailable ? availableSel : installedSel;
  const setSelected = showAvailable ? setAvailableSel : setInstalledSel;

  // Ensure selection lands on a selectable item
  useEffect(() => {
    if (items.length > 0 && items[selected]?.type !== 'skill') {
      const first = items.findIndex((i) => i.type === 'skill');
      if (first >= 0) setSelected(first);
    }
  }, [items, selected]);

  const selectedSkill =
    items[selected]?.type === 'skill' ? items[selected].skill : null;

  useEffect(() => {
    if (selectedSkill) {
      setDetailContent(data.readSkillContent(selectedSkill.path));
    } else {
      setDetailContent('');
    }
  }, [selectedSkill?.path]);

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
      } else if (key.tab && key.shift) {
        setFocusDetail((f) => !f);
      } else if (
        input === 'i' &&
        showAvailable &&
        selectedSkill &&
        !selectedSkill.installed
      ) {
        data.installSkill(selectedSkill.path, selectedSkill.name);
        refresh();
        setAvailableSel(0);
      } else if (
        input === 'u' &&
        !showAvailable &&
        selectedSkill &&
        selectedSkill.installed
      ) {
        data.uninstallSkill(selectedSkill.name);
        refresh();
        setInstalledSel((s) => Math.min(s, Math.max(0, installed.length - 2)));
      } else if (input === 'a') {
        setAddingSource(true);
      }
    },
    {},
  );

  const subTabHeight = 2;
  const actualListHeight = listHeight - subTabHeight;
  const maxDesc = cols - 4;

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
          <Text bold inverse={!showAvailable}>
            {' '}
            Installed ({installed.length}){' '}
          </Text>
          <Text> </Text>
          <Text bold inverse={showAvailable}>
            {' '}
            Available ({available.length}){' '}
          </Text>
        </Box>
        <Text dimColor>{'─'.repeat(cols)}</Text>
      </Box>
      <Box flexDirection="column" height={actualListHeight}>
        <ListView
          items={items}
          selected={selected}
          onSelect={setSelected}
          height={actualListHeight}
          itemHeight={ITEM_HEIGHT}
          isFocused={!focusDetail && !addingSource}
          isSelectable={(item) => item.type === 'skill'}
          renderItem={(item, _idx, isSel) => {
            if (item.type === 'header') {
              return (
                <Box flexDirection="column" height={ITEM_HEIGHT}>
                  <Text> </Text>
                  <Text dimColor bold>
                    {'  '}
                    {item.label}
                  </Text>
                  <Text> </Text>
                </Box>
              );
            }
            const s = item.skill;
            const borderColor = isSel ? 'magenta' : undefined;
            return (
              <Box flexDirection="column" height={ITEM_HEIGHT}>
                <Box>
                  <Text color={borderColor} dimColor={!isSel}>
                    {'  │ '}
                  </Text>
                  <Text
                    bold={isSel}
                    color={s.installed ? 'green' : isSel ? 'white' : undefined}
                  >
                    {s.name}
                  </Text>
                </Box>
                <Box>
                  <Text color={borderColor} dimColor={!isSel}>
                    {'  │ '}
                  </Text>
                  <Text dimColor>{s.description.slice(0, maxDesc)}</Text>
                </Box>
                <Text> </Text>
              </Box>
            );
          }}
        />
      </Box>
      <DetailPanel
        title={selectedSkill ? `${selectedSkill.name} — SKILL.md` : 'Skill Details'}
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
