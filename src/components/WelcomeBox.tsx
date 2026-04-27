import React from "react";
import { Box, Text } from "ink";
import { userInfo, homedir } from "os";
import { useTerminalSize } from "../hooks/useTerminalSize";

// The full ASCII mark — kept exported for the vault setup success screen.
export const LOGO_LARGE = [
  " ██████╗ ██████╗███████╗",
  "██╔════╝██╔════╝██╔════╝",
  "██║     ██║     ███████╗",
  "██║     ██║     ╚════██║",
  "╚██████╗╚██████╗███████║",
  " ╚═════╝ ╚═════╝╚══════╝",
];

// Small mark used here in the welcome card.
export const LOGO_SMALL = [
  "▄▀▀ ▄▀▀ ▄▀▀",
  "█   █   ▀▀▄",
  "▀▀▘ ▀▀▘ ▀▀▀",
];

const ACCENT = "#8ab4f8";
const MUTED = "#8b92ac";

const HINTS: Array<{ command: string; desc: string }> = [
  { command: "/migrate rewrite", desc: "scan, reverse-engineer, verify" },
  { command: "/migrate open",    desc: "open latest result folder" },
  { command: "/migrate open --dashboard", desc: "open latest dashboard" },
  { command: "/setup",           desc: "wire Codex / Claude Code via MCP" },
  { command: "/guide",           desc: "interactive manual" },
];

const START_HINT = 'migrate <repo url> to csharp" or "open the dashboard';

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
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

  // Compact Claude/Codex-style start panel. No heavy chrome; the terminal
  // transcript should stay the primary UI.
  const cardWidth = Math.max(50, Math.min(columns - 4, 88));
  const innerWidth = cardWidth - 4;

  // Logo column reserved on the left of the header band.
  const logoCol = LOGO_SMALL[0]?.length ?? 11;
  const headerTextWidth = Math.max(20, innerWidth - logoCol - 3);

  // Command list dims.
  const cmdCol = 28;
  const descCol = Math.max(12, innerWidth - cmdCol - 2);

  const metaWidth = Math.max(20, innerWidth - 2);
  const cwdRoom = Math.max(8, metaWidth - model.length - 3);

  return (
    <Box paddingX={2} marginTop={1} marginBottom={1} flexDirection="column" width={cardWidth}>
      <Box
        flexDirection="column"
        width={cardWidth}
      >
        {/* Header: small logo on the left, identity on the right ----------- */}
        <Box flexDirection="row">
          <Box flexDirection="column" marginRight={2}>
            {LOGO_SMALL.map((line, i) => (
              <Text key={i} color={ACCENT} bold>{line}</Text>
            ))}
          </Box>
          <Box flexDirection="column" width={headerTextWidth}>
            <Text>
              <Text bold>CCS Code</Text> <Text color={MUTED}>for</Text> <Text color={ACCENT} bold>{username}</Text>
            </Text>
            <Text color={MUTED}>
              {truncateEnd("CCS Code · migration intelligence for legacy modernization", headerTextWidth)}
            </Text>
            <Text color={MUTED}>
              {truncateEnd(`${model} · ${truncateMiddle(cwd, cwdRoom)}`, headerTextWidth)}
            </Text>
          </Box>
        </Box>

        {/* Command hints --------------------------------------------------- */}
        <Box flexDirection="column" marginTop={1}>
          {HINTS.map((hint) => (
            <Box key={hint.command} flexDirection="row">
              <Text color={ACCENT} bold>{hint.command.padEnd(cmdCol)}</Text>
              <Text color={MUTED}>{truncateEnd(hint.desc, descCol)}</Text>
            </Box>
          ))}
        </Box>

        {/* Natural-language hint ------------------------------------------- */}
        <Box marginTop={1}>
          <Text color={MUTED}>
            Type <Text color={ACCENT}>"{START_HINT}"</Text> — plain words work too.
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
