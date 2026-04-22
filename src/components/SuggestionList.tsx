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

  const icon = mode === "file" ? "📄" : "⚡";
  const header = mode === "file" ? " @ File" : " / Command";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="white"
      paddingX={1}
      marginX={2}
      marginBottom={0}
    >
      {/* Header */}
      <Box marginBottom={0}>
        <Text color="white">{icon}{header} — ↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>

      {/* Items */}
      {items.map((item, i) => {
        const isSelected = i === selectedIndex;
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
                color={isSelected ? "cyan" : "white"}
              >
                {item.label}
              </Text>
            </Box>

            {/* Optional description */}
            {item.description && (
              <Box marginLeft={2}>
                <Text color="gray">{item.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
