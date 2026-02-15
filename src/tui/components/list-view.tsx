import React, { useState, useEffect, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';

interface ListViewProps<T> {
  items: T[];
  selected: number;
  onSelect: (index: number) => void;
  renderItem: (item: T, index: number, isSelected: boolean) => ReactNode;
  height: number;
  itemHeight?: number;
  isFocused?: boolean;
  isSelectable?: (item: T, index: number) => boolean;
  onSubmit?: (item: T, index: number) => void;
}

export function ListView<T>({
  items,
  selected,
  onSelect,
  renderItem,
  height,
  itemHeight = 1,
  isFocused = true,
  isSelectable,
  onSubmit,
}: ListViewProps<T>) {
  const safeItems = Array.isArray(items) ? items : [];
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleCount = Math.max(1, Math.floor(height / itemHeight));

  useEffect(() => {
    if (selected < scrollOffset) {
      setScrollOffset(selected);
    } else if (selected >= scrollOffset + visibleCount) {
      setScrollOffset(selected - visibleCount + 1);
    }
  }, [selected, scrollOffset, visibleCount]);

  const findNextSelectable = (from: number, direction: 1 | -1): number => {
    if (!isSelectable) return Math.max(0, Math.min(from, safeItems.length - 1));
    let idx = from;
    while (idx >= 0 && idx < safeItems.length) {
      if (isSelectable(safeItems[idx], idx)) return idx;
      idx += direction;
    }
    return selected;
  };

  useInput(
    (input, key) => {
      if (!isFocused || safeItems.length === 0) return;

      if (key.pageDown) {
        onSelect(findNextSelectable(Math.min(selected + visibleCount, safeItems.length - 1), -1));
      } else if (key.pageUp) {
        onSelect(findNextSelectable(Math.max(selected - visibleCount, 0), 1));
      } else if (input === 'j' || key.downArrow) {
        onSelect(findNextSelectable(selected + 1, 1));
      } else if (input === 'k' || key.upArrow) {
        onSelect(findNextSelectable(selected - 1, -1));
      } else if (input === 'g') {
        onSelect(findNextSelectable(0, 1));
      } else if (input === 'G') {
        onSelect(findNextSelectable(safeItems.length - 1, -1));
      } else if (key.return && onSubmit) {
        onSubmit(safeItems[selected], selected);
      }
    },
    { isActive: isFocused },
  );

  if (safeItems.length === 0) {
    return (
      <Box>
        <Text dimColor>(empty)</Text>
      </Box>
    );
  }

  const visible = safeItems.slice(scrollOffset, scrollOffset + visibleCount);

  return (
    <Box flexDirection="column" height={height}>
      {visible.map((item, i) => {
        const realIndex = scrollOffset + i;
        return (
          <Box key={realIndex} height={itemHeight}>
            {renderItem(item, realIndex, realIndex === selected)}
          </Box>
        );
      })}
    </Box>
  );
}
