import React, { useState, useEffect, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';

interface ListViewProps<T> {
  items: T[];
  selected: number;
  onSelect: (index: number) => void;
  renderItem: (item: T, index: number, isSelected: boolean) => ReactNode;
  height: number;
  isFocused?: boolean;
  onSubmit?: (item: T, index: number) => void;
}

export function ListView<T>({
  items,
  selected,
  onSelect,
  renderItem,
  height,
  isFocused = true,
  onSubmit,
}: ListViewProps<T>) {
  const safeItems = Array.isArray(items) ? items : [];
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleCount = Math.max(1, height);

  useEffect(() => {
    if (selected < scrollOffset) {
      setScrollOffset(selected);
    } else if (selected >= scrollOffset + visibleCount) {
      setScrollOffset(selected - visibleCount + 1);
    }
  }, [selected, scrollOffset, visibleCount]);

  useInput(
    (input, key) => {
      if (!isFocused || safeItems.length === 0) return;

      if (input === 'j' || key.downArrow) {
        onSelect(Math.min(selected + 1, safeItems.length - 1));
      } else if (input === 'k' || key.upArrow) {
        onSelect(Math.max(selected - 1, 0));
      } else if (input === 'g') {
        onSelect(0);
      } else if (input === 'G') {
        onSelect(safeItems.length - 1);
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
          <Box key={realIndex}>
            {renderItem(item, realIndex, realIndex === selected)}
          </Box>
        );
      })}
    </Box>
  );
}
