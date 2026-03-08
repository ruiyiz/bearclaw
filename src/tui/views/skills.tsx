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

function filterMatch(query: string, text: string): boolean {
  const t = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => t.includes(term));
}

export function SkillsView({ listHeight, detailHeight }: ViewProps) {
  const [installed, setInstalled] = useState<data.SkillInfo[]>([]);
  const [sources, setSources] = useState<data.SkillSource[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [tabSelections, setTabSelections] = useState<Map<number, number>>(new Map());
  const [focusDetail, setFocusDetail] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [sourceInput, setSourceInput] = useState('');
  const [detailContent, setDetailContent] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [filterMode, setFilterMode] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const refresh = useCallback(() => {
    setInstalled(data.getInstalledSkills());
    setSources(data.getAllSkillSources());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Clear filter when switching tabs
  useEffect(() => {
    setFilterMode(false);
    setFilterQuery('');
  }, [activeTab]);

  const installedItems: SkillListItem[] = useMemo(
    () => installed.map((s) => ({ type: 'skill' as const, skill: s })),
    [installed],
  );

  const sourceSkillCounts = useMemo(() => {
    return sources.map((src) => data.getAvailableSkillsForSource(src.dir).length);
  }, [sources, installed]);

  const getSourceItems = useCallback(
    (tabIdx: number): SkillListItem[] => {
      if (tabIdx === 0) return installedItems;
      const src = sources[tabIdx - 1];
      if (!src) return [];
      return data
        .getAvailableSkillsForSource(src.dir)
        .map((s) => ({ type: 'skill' as const, skill: s }));
    },
    [sources, installedItems],
  );

  const rawItems = useMemo(() => getSourceItems(activeTab), [getSourceItems, activeTab]);

  const items = useMemo(() => {
    if (!filterQuery) return rawItems;
    return rawItems.filter((item) => {
      if (item.type !== 'skill') return false;
      const haystack = `${item.skill.name} ${item.skill.description} ${item.skill.source}`;
      return filterMatch(filterQuery, haystack);
    });
  }, [rawItems, filterQuery]);

  const selected = tabSelections.get(activeTab) ?? 0;

  const setSelected = useCallback(
    (idx: number) => {
      setTabSelections((prev) => new Map(prev).set(activeTab, idx));
    },
    [activeTab],
  );

  // Ensure selection is on a selectable item
  useEffect(() => {
    if (items.length > 0 && items[selected]?.type !== 'skill') {
      const first = items.findIndex((i) => i.type === 'skill');
      if (first >= 0) setSelected(first);
    }
  }, [items, selected]);

  // Reset selection to 0 when filter changes
  useEffect(() => {
    setSelected(0);
  }, [filterQuery]);

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

      if (filterMode) {
        if (key.return || key.escape) {
          if (key.escape) setFilterQuery('');
          setFilterMode(false);
        }
        return;
      }

      if (key.tab && !key.shift) {
        setActiveTab((t) => (t + 1) % (1 + sources.length));
      } else if (key.tab && key.shift) {
        setFocusDetail((f) => !f);
      } else if (input === '/') {
        setFilterMode(true);
      } else if (input === 'i' && activeTab > 0 && selectedSkill && !selectedSkill.installed) {
        data.installSkill(selectedSkill.path, selectedSkill.name);
        refresh();
        setSelected(0);
      } else if (input === 'u' && activeTab === 0 && selectedSkill?.installed) {
        data.uninstallSkill(selectedSkill.name);
        refresh();
        setTabSelections((prev) =>
          new Map(prev).set(0, Math.min(selected, Math.max(0, installed.length - 2))),
        );
      } else if (input === 's' && activeTab === 0) {
        const result = data.syncInstalledSkills();
        refresh();
        const msg =
          result.synced.length > 0
            ? `Synced: ${result.synced.join(', ')}`
            : 'Nothing to sync';
        setSyncMessage(msg);
        setTimeout(() => setSyncMessage(''), 3000);
      } else if (input === 'a') {
        setAddingSource(true);
      }
    },
    {},
  );

  const subTabHeight = 2;
  const actualListHeight = listHeight - subTabHeight - 1;
  const maxDesc = cols - 4;

  const tabLabels = ['Installed', ...sources.map((s) => s.label)];
  const tabCounts = [installed.length, ...sourceSkillCounts];

  return (
    <Box flexDirection="column">
      {addingSource && (
        <Box>
          <Text bold>Source directory: </Text>
          <TextInput value={sourceInput} onChange={setSourceInput} />
        </Box>
      )}
      {syncMessage && (
        <Box>
          <Text color="green">{syncMessage}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        <Box>
          {tabLabels.map((label, idx) => (
            <React.Fragment key={idx}>
              <Text bold inverse={activeTab === idx}>
                {' '}
                {label} ({tabCounts[idx]}){' '}
              </Text>
              {idx < tabLabels.length - 1 && <Text> </Text>}
            </React.Fragment>
          ))}
        </Box>
        <Text dimColor>{'─'.repeat(cols)}</Text>
      </Box>
      <Box>
          <Text dimColor>{'/ '}</Text>
          {filterMode ? (
            <TextInput value={filterQuery} onChange={setFilterQuery} />
          ) : (
            <Text dimColor={!filterQuery} color={filterQuery ? 'yellow' : undefined}>
              {filterQuery || 'filter…'}
            </Text>
          )}
          {filterQuery && !filterMode && (
            <Text dimColor>{`  (${items.length} match${items.length !== 1 ? 'es' : ''})`}</Text>
          )}
        </Box>
      <Box flexDirection="column" height={actualListHeight}>
        <ListView
          items={items}
          selected={selected}
          onSelect={setSelected}
          height={actualListHeight}
          itemHeight={ITEM_HEIGHT}
          isFocused={!focusDetail && !addingSource && !filterMode}
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
          { key: 'Tab', label: 'Next Tab' },
          ...(activeTab === 0
            ? [
                { key: 'u', label: 'Uninstall' },
                { key: 's', label: 'Sync' },
              ]
            : [{ key: 'i', label: 'Install' }]),
          { key: '/', label: 'Filter' },
          { key: 'a', label: 'Add Source' },
          { key: 'S-Tab', label: 'Focus' },
        ]}
      />
    </Box>
  );
}
