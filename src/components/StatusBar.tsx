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

  // Compact single-line footer — mirrors Claude Code's bottom status bar
  const left = `${model} · ${sandboxStatus} · ${dir}`;
  const right = `${instructionsCount} md · ${skillsCount} skills · ? for shortcuts`;

  const gap = Math.max(1, width - left.length - right.length - 4);
  const showRight = width >= 80;

  return (
    <Box paddingX={2} marginTop={1}>
      <Text dimColor>
        {left}
        {showRight && " ".repeat(gap) + right}
      </Text>
    </Box>
  );
}
