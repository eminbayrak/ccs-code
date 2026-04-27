import React from "react";
import { Box, Text } from "ink";
import { userInfo, homedir } from "os";
import { useTerminalSize } from "../hooks/useTerminalSize";

const ACCENT = "#63b3ed"; 
const MUTED = "#4a5568";
const DIM = "#718096";

export const LOGO_SMALL = [
  "▄▀▀ ▄▀▀ ▄▀▀",
  "█   █   ▀▀▄",
  "▀▀▘ ▀▀▘ ▀▀▀",
];

const HINTS: Array<{ command: string; desc: string }> = [
  { command: "/migrate",         desc: "Launch migration wizard" },
  { command: "/migrate open",    desc: "Open latest result folder" },
  { command: "/migrate open --dashboard", desc: "Open dashboard.html" },
  { command: "/setup",           desc: "MCP configuration" },
  { command: "/guide",           desc: "Interactive walkthrough" },
];

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

type Props = {
  activeModel: string;
  workspacePath: string;
};

export function WelcomeBox({ activeModel, workspacePath }: Props) {
  const { columns } = useTerminalSize();
  const username = userInfo().username;
  const model = activeModel === "Loading..." ? "…" : activeModel;
  const cwd = workspacePath.replace(homedir(), "~");

  const cardWidth = Math.max(50, Math.min(columns - 4, 100));
  const innerWidth = cardWidth - 4;

  return (
    <Box paddingX={1} marginTop={1} marginBottom={1} flexDirection="column" width={cardWidth}>
      {/* Prompt-style Header with Logo */}
      <Box 
        backgroundColor="#30343d" 
        paddingX={2} 
        paddingY={1} 
        flexDirection="row"
        gap={2}
        borderStyle="single"
        borderLeft
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={ACCENT}
      >
        <Box flexDirection="column">
          {LOGO_SMALL.map((line, i) => (
            <Text key={i} color={ACCENT} bold>{line}</Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Box flexDirection="row" gap={1}>
            <Text color={ACCENT} bold>CCS Code</Text>
            <Text color={DIM}>&middot;</Text>
            <Text color="#e2e8f0">{username}</Text>
            <Text color={DIM}>&middot;</Text>
            <Text color={DIM}>{truncateMiddle(cwd, 30)}</Text>
          </Box>
        </Box>
      </Box>

      {/* Compact Hints List */}
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Text color={DIM}>Available commands:</Text>
        {HINTS.map((hint, i) => (
          <Box key={i} flexDirection="row" gap={2} marginBottom={0}>
            <Text color={ACCENT} bold>{hint.command.padEnd(20)}</Text>
            <Text color={DIM}>{hint.desc}</Text>
          </Box>
        ))}
      </Box>

      {/* Status Bar style line */}
      <Box marginTop={1} paddingLeft={2}>
        <Text color={DIM}>
          Active model: <Text color="#cbd5e1">{model}</Text> &middot; Type <Text color={ACCENT}>"?"</Text> for shortcuts
        </Text>
      </Box>
    </Box>
  );
}
