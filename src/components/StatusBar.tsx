import React from "react";
import { Box, Text } from "ink";
import { basename } from "path";

type StatusBarProps = {
  workspacePath: string;
  sandboxStatus: string;
  activeModel: string;
  instructionsCount: number;
  skillsCount: number;
  terminalWidth?: number;
};

export function StatusBar({
  workspacePath,
  sandboxStatus,
  activeModel,
  instructionsCount,
  skillsCount,
  terminalWidth,
}: StatusBarProps) {
  const dir = basename(workspacePath) || workspacePath;
  const width = terminalWidth ?? process.stdout.columns ?? 120;
  const model = activeModel === "Loading..." ? "…" : activeModel;

  // Compact single-line footer — mirrors Claude Code's bottom status bar.
  // Layout uses flex space-between + truncate-end so the line can never wrap,
  // regardless of small off-by-one terminal-width quirks.
  const left = `${model} · ${sandboxStatus} · ${dir}`;
  const rightLong = `${instructionsCount} md · ${skillsCount} skills · ? for shortcuts`;
  const rightShort = `${instructionsCount} md · ${skillsCount} skills · ?`;

  // The right column shows progressively less as the terminal narrows.
  const showRightLong = width >= 80;
  const showRightShort = width >= 60 && !showRightLong;

  return (
    <Box paddingX={2} marginTop={1} width={width} flexDirection="row" justifyContent="space-between">
      <Box flexGrow={0} flexShrink={1}>
        <Text dimColor wrap="truncate-end">{left}</Text>
      </Box>
      {showRightLong && (
        <Box flexGrow={0} flexShrink={0} marginLeft={2}>
          <Text dimColor wrap="truncate-end">{rightLong}</Text>
        </Box>
      )}
      {showRightShort && (
        <Box flexGrow={0} flexShrink={0} marginLeft={2}>
          <Text dimColor wrap="truncate-end">{rightShort}</Text>
        </Box>
      )}
    </Box>
  );
}
