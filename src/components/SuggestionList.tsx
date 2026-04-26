import React from "react";
import { Box, Text } from "ink";

export type SuggestionItem = {
  id: string;
  label: string;
  description?: string;
};

type Props = {
  items: SuggestionItem[];
  selectedIndex: number;
  mode: "file" | "command";
};

export function SuggestionList({ items, selectedIndex, mode }: Props) {
  if (items.length === 0) return null;

  const header = mode === "file" ? "@ files" : "/ commands";
  const start = selectedIndex >= 14 ? selectedIndex - 13 : 0;
  const visibleItems = items.slice(start, start + 14);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#46506a"
      paddingX={1}
      marginX={1}
      marginTop={0}
      marginBottom={0}
    >
      {/* Header */}
      <Box marginBottom={0} justifyContent="space-between">
        <Text color="#8ab4f8" bold>{header}</Text>
        <Text color="#7f8798">↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>

      {/* Items */}
      {visibleItems.map((item, i) => {
        const absoluteIndex = start + i;
        const isSelected = absoluteIndex === selectedIndex;
        return (
          <Box key={item.id} flexDirection="row">
            {/* Selection indicator */}
            <Box width={2}>
              <Text color="cyan">{isSelected ? "❯" : " "}</Text>
            </Box>

            {/* Label */}
            <Box flexGrow={1}>
              <Text
                bold={isSelected}
                color={isSelected ? "#8ab4f8" : "#d8def4"}
              >
                {item.label}
              </Text>
            </Box>

            {/* Optional description */}
            {item.description && (
              <Box marginLeft={2}>
                <Text color="#8b92ac">{item.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      {hiddenCount > 0 && (
        <Box marginLeft={2}>
          <Text color="#7f8798">showing {start + 1}-{start + visibleItems.length} of {items.length}; keep typing to narrow</Text>
        </Box>
      )}
    </Box>
  );
}
