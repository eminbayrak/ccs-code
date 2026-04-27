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
  terminalWidth?: number;
};

const SEL_BG   = "#2d3748";
const SEL_CMD  = "#7dd3fc"; // bright blue for selected command
const DIM_CMD  = "#c9d1d9"; // normal command text
const DIM_ARG  = "#4a5568"; // args / placeholders
const DIM_DESC = "#718096"; // description column
const SEL_DESC = "#94a3b8"; // description when selected
const BORDER   = "#2d3748";
const HEADER   = "#4a5568";

export function SuggestionList({ items, selectedIndex, mode, terminalWidth }: Props) {
  if (items.length === 0) return null;

  const MAX_VISIBLE = 7;
  const start = selectedIndex >= MAX_VISIBLE ? selectedIndex - (MAX_VISIBLE - 1) : 0;
  const visibleItems = items.slice(start, start + MAX_VISIBLE);
  const screenWidth  = terminalWidth ?? process.stdout.columns ?? 120;
  const popupWidth   = Math.max(64, Math.min(screenWidth - 2, 110));

  // Fixed column widths: cmd gets ~38%, desc fills right
  const CMD_COL  = Math.floor(popupWidth * 0.38);
  const DESC_COL = popupWidth - CMD_COL - 4; // 4 = left pad + gutter

  return (
    <Box flexDirection="column" width={popupWidth}>
      {/* Container */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BORDER}
        paddingX={1}
        paddingY={0}
        width={popupWidth}
      >
        {/* Header row */}
        <Box flexDirection="row" gap={1} marginBottom={0}>
          <Text color={HEADER}>
            {mode === "command" ? "/ commands" : "@ files"}
          </Text>
          <Text color={DIM_ARG}> · ↑↓ navigate · Tab/Enter select · Esc close</Text>
        </Box>

        {/* Divider */}
        <Box>
          <Text color={BORDER}>{"─".repeat(popupWidth - 4)}</Text>
        </Box>

        {/* Items */}
        {visibleItems.map((item, i) => {
          const absoluteIndex = start + i;
          const isSelected    = absoluteIndex === selectedIndex;

          // Split label into command (/cmd) and the rest (args/flags)
          const spaceIdx = item.label.indexOf(" ");
          const cmd  = spaceIdx > 0 ? item.label.slice(0, spaceIdx) : item.label;
          const args = spaceIdx > 0 ? item.label.slice(spaceIdx + 1) : "";

          return (
            <Box
              key={item.id}
              flexDirection="row"
              paddingX={0}
              backgroundColor={isSelected ? SEL_BG : undefined}
            >
              {/* Command column — single Text with truncate so spaces don't cause wrapping */}
              <Box width={CMD_COL} flexShrink={0}>
                <Text
                  bold={isSelected}
                  color={isSelected ? SEL_CMD : DIM_CMD}
                  wrap="truncate-end"
                >
                  {cmd}
                  {args ? <Text color={DIM_ARG}> {args}</Text> : null}
                </Text>
              </Box>

              {/* Description column */}
              <Box width={DESC_COL} flexShrink={1}>
                <Text
                  color={isSelected ? SEL_DESC : DIM_DESC}
                  wrap="truncate-end"
                >
                  {item.description ?? ""}
                </Text>
              </Box>
            </Box>
          );
        })}

        {/* Footer: scroll position hint */}
        {items.length > MAX_VISIBLE && (
          <Box marginTop={0}>
            <Text color={DIM_ARG}>
              {start + 1}–{start + visibleItems.length} of {items.length} · keep typing to narrow
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
