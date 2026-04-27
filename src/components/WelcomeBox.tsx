import React from "react";
import { Box, Text } from "ink";
import { userInfo, homedir } from "os";
import { useTerminalSize } from "../hooks/useTerminalSize";

const ACCENT = "#63b3ed";
const DIM    = "#718096";
const MUTED  = "#4a5568";

// ---------------------------------------------------------------------------
// ANSI Shadow logo for "CCS"
// Generated with figlet ANSI Shadow + universal smushing
// ---------------------------------------------------------------------------
export const LOGO_BIG: string[] = [
  " ██████╗█████████████╗",
  "██╔════██╔════██╔════╝",
  "██║    ██║    ███████╗ ",
  "██║    ██║    ╚════██║ ",
  "╚██████╚█████████████║ ",
  " ╚═════╝╚═════╚══════╝ ",
];

// Fallback small logo for very narrow terminals
export const LOGO_SMALL: string[] = [
  "▄▀▀ ▄▀▀ ▄▀▀",
  "█   █   ▀▀▄",
  "▀▀▘ ▀▀▘ ▀▀▀",
];

// ---------------------------------------------------------------------------
// Pipeline steps — every entry maps to a real slash command
// ---------------------------------------------------------------------------
const PIPELINE: Array<{ step: string; cmd: string; desc: string }> = [
  { step: "1", cmd: "/vault init",  desc: "Create your knowledge base" },
  { step: "2", cmd: "/sync",        desc: "Pull GitHub repos & sources" },
  { step: "3", cmd: "/harvest",     desc: "Mine Claude · Cursor · Copilot logs" },
  { step: "4", cmd: "/ingest",      desc: "Convert raw files → wiki pages" },
  { step: "5", cmd: "/enrich",      desc: "AI summaries + tags + wikilinks" },
  { step: "6", cmd: "/graph",       desc: "Build interactive knowledge graph" },
  { step: "7", cmd: "/ask",         desc: "Answer questions from your wiki" },
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
  const model    = activeModel === "Loading..." ? "…" : activeModel;
  const cwd      = workspacePath.replace(homedir(), "~");

  // Wide layout: ≥70 cols — show big ANSI Shadow logo + pipeline side-by-side
  // Narrow layout: <70 cols — stacked, small logo
  const isWide   = columns >= 70;
  const cardWidth = Math.min(columns - 2, 100);

  if (isWide) {
    const logoWidth   = LOGO_BIG[0]!.length + 2; // +2 for padding
    const rightWidth  = Math.max(30, cardWidth - logoWidth - 2);

    return (
      <Box
        flexDirection="column"
        marginTop={1}
        marginBottom={1}
        width={cardWidth}
      >
        {/* ── Top: logo left + identity+pipeline right ── */}
        <Box flexDirection="row" gap={1}>

          {/* Left: big ASCII logo */}
          <Box flexDirection="column" paddingRight={1}>
            {LOGO_BIG.map((line, i) => (
              <Text key={i} color={ACCENT} bold>{line}</Text>
            ))}
            {/* Tagline below logo */}
            <Text color={MUTED}>AI-powered knowledge base</Text>
          </Box>

          {/* Right: identity + pipeline */}
          <Box flexDirection="column" width={rightWidth}>
            {/* Identity row */}
            <Box
              flexDirection="column"
              paddingX={1}
              paddingY={0}
              borderStyle="single"
              borderLeft
              borderRight={false}
              borderTop={false}
              borderBottom={false}
              borderColor={ACCENT}
              marginBottom={1}
            >
              <Box flexDirection="row" gap={1}>
                <Text color="#e2e8f0" bold>{username}</Text>
                <Text color={MUTED}>·</Text>
                <Text color={DIM} wrap="truncate-end">{truncateMiddle(cwd, rightWidth - 12)}</Text>
              </Box>
              <Text color={DIM}>
                model <Text color="#cbd5e1">{model}</Text>
              </Text>
            </Box>

            {/* Pipeline steps */}
            <Box flexDirection="column">
              {PIPELINE.map(({ step, cmd, desc }) => (
                <Box key={step} flexDirection="row" gap={1}>
                  <Text color={MUTED}>{step}.</Text>
                  <Text color={ACCENT}>{cmd.padEnd(14)}</Text>
                  <Text color={DIM} wrap="truncate-end">{desc}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>

        {/* ── Bottom hint ── */}
        <Box marginTop={1}>
          <Text color={MUTED}>
            type <Text color={ACCENT}>/</Text> for commands
            {"  "}type <Text color={ACCENT}>?</Text> for keyboard shortcuts
            {"  "}<Text color={MUTED}>esc to cancel</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  // ── Narrow layout ──────────────────────────────────────────────────────────
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      width={cardWidth}
      paddingX={1}
    >
      {/* Small logo + identity */}
      <Box flexDirection="row" alignItems="center" gap={2} marginBottom={1}>
        <Box flexDirection="column">
          {LOGO_SMALL.map((line, i) => (
            <Text key={i} color={ACCENT} bold>{line}</Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text color={ACCENT} bold>CCS Code</Text>
          <Text color={DIM} wrap="truncate-end">{truncateMiddle(cwd, 22)}</Text>
          <Text color={DIM}>model <Text color="#cbd5e1">{model}</Text></Text>
        </Box>
      </Box>

      {/* Pipeline steps compact */}
      <Box flexDirection="column">
        {PIPELINE.map(({ step, cmd }) => (
          <Box key={step} flexDirection="row" gap={1}>
            <Text color={MUTED}>{step}.</Text>
            <Text color={ACCENT}>{cmd}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color={MUTED}>type <Text color={ACCENT}>/</Text> for commands · <Text color={ACCENT}>?</Text> for shortcuts</Text>
      </Box>
    </Box>
  );
}
