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

const DIM = "#718096";

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
  const model = activeModel === "Loading..." ? "Gemini" : activeModel;

  const left = `${model} · ${sandboxStatus} · ${dir}`;
  const right = `${instructionsCount} md · ${skillsCount} skills · ? for shortcuts`;

  return (
    <Box paddingX={1} marginTop={1} width={width} flexDirection="row" justifyContent="space-between">
      <Box>
        <Text color={DIM}>{left}</Text>
      </Box>
      <Box>
        <Text color={DIM}>{right}</Text>
      </Box>
    </Box>
  );
}
