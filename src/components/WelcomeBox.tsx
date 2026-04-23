import React from "react";
import { Box, Text } from "ink";
import { userInfo, homedir } from "os";
import { useTerminalSize } from "../hooks/useTerminalSize";

// ─── Logo variants ────────────────────────────────────────────────────────────

export const LOGO_LARGE = [
  " ██████╗ ██████╗███████╗",
  "██╔════╝██╔════╝██╔════╝",
  "██║     ██║     ███████╗",
  "██║     ██║     ╚════██║",
  "╚██████╗╚██████╗███████║",
  " ╚═════╝ ╚═════╝╚══════╝",
];

export const LOGO_SMALL = [
  "▄▀▀ ▄▀▀ ▄▀▀",
  "█   █   ▀▀▄",
  "▀▀▘ ▀▀▘ ▀▀▀",
];

// ─── Content ──────────────────────────────────────────────────────────────────

const PIPELINE: Array<{ step: string; cmd: string; desc: string }> = [
  { step: "1", cmd: "/vault init",  desc: "create your knowledge base" },
  { step: "2", cmd: "/harvest",    desc: "mine local AI/IDE histories" },
  { step: "3", cmd: "/sync",        desc: "pull from GitHub repos" },
  { step: "4", cmd: "/ingest",      desc: "process files into wiki pages" },
  { step: "5", cmd: "/enrich",      desc: "add AI summaries + links" },
  { step: "6", cmd: "/graph",       desc: "open visual knowledge graph" },
  { step: "7", cmd: "/ask <q>",     desc: "ask questions about your wiki" },
];

const QUICK_TIPS = [
  "Run /vault audit to check for missing memories",
  "Drop any file into raw/uploads/ then run /ingest",
  "Just type a question to chat without /ask",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncatePath(p: string, max: number): string {
  if (p.length <= max) return p;
  return "…" + p.slice(-(max - 1));
}

type Props = {
  activeModel: string;
  workspacePath: string;
};

// ─── Wide layout (≥ 95 cols) ─────────────────────────────────────────────────

function WideLayout({
  columns,
  username,
  model,
  dir,
}: {
  columns: number;
  username: string;
  model: string;
  dir: string;
}) {
  const LEFT = 34;
  const boxWidth = columns - 2;

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      width={boxWidth}
      marginX={1}
      marginTop={1}
      flexDirection="column"
    >
      <Box paddingLeft={1} paddingTop={0}>
        <Text dimColor>── </Text>
        <Text bold color="white">CCS Code</Text>
        <Text dimColor>  Your AI-powered knowledge base ────────────────────────────────────</Text>
      </Box>

      <Box flexDirection="row">
        <Box
          width={LEFT}
          flexShrink={0}
          flexDirection="column"
          alignItems="center"
          paddingX={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <Text bold>
            Welcome back, <Text color="cyan">{username}</Text>!
          </Text>

          <Box marginTop={1} marginBottom={1} flexDirection="column" alignItems="center">
            {LOGO_LARGE.map((line, i) => (
              <Text key={i} color="cyan">{line}</Text>
            ))}
          </Box>

          <Box flexDirection="column" alignItems="center">
            <Text dimColor>{model}</Text>
            <Text dimColor>{dir}</Text>
          </Box>
        </Box>

        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor="gray"
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <Text bold color="white">Pipeline</Text>
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            {PIPELINE.map(({ step, cmd, desc }) => (
              <Box key={step}>
                <Text dimColor>{step}. </Text>
                <Text color="cyan" bold>{cmd.padEnd(14)}</Text>
                <Text dimColor>{desc}</Text>
              </Box>
            ))}
          </Box>

          <Box marginBottom={1}>
            <Text dimColor>{"─".repeat(Math.max(10, boxWidth - LEFT - 7))}</Text>
          </Box>

          <Text bold color="white">Tips</Text>
          <Box marginTop={1} flexDirection="column">
            {QUICK_TIPS.map((tip, i) => (
              <Box key={i}>
                <Text color="yellow">  · </Text>
                <Text dimColor>{tip}</Text>
              </Box>
            ))}
          </Box>

          <Box marginTop={2} justifyContent="center">
            <Text dimColor>
              Type <Text color="cyan" bold>?</Text> for help  ·  <Text color="cyan" bold>/guide</Text> for manual  ·  Just type to chat
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function CompactLayout({
  columns,
  username,
  model,
  dir,
}: {
  columns: number;
  username: string;
  model: string;
  dir: string;
}) {
  const boxWidth = Math.max(42, columns - 2);
  const showLargeLogo = boxWidth >= 32;

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      flexDirection="column"
      width={boxWidth}
      marginX={1}
      marginTop={1}
      paddingX={2}
      paddingY={1}
    >
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <Text bold>
          Welcome back, <Text color="cyan">{username}</Text>!
        </Text>
        <Text dimColor>Your AI-powered knowledge base</Text>
      </Box>

      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        {(showLargeLogo ? LOGO_LARGE : LOGO_SMALL).map((line, i) => (
          <Text key={i} color="cyan">{line}</Text>
        ))}
      </Box>

      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <Text dimColor>{model}</Text>
        <Text dimColor>{dir}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{"─".repeat(Math.max(10, boxWidth - 6))}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold color="white">Getting started</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {PIPELINE.map(({ step, cmd, desc }) => (
          <Box key={step}>
            <Text dimColor>{step}. </Text>
            <Text color="cyan" bold>{cmd.padEnd(13)}</Text>
            <Text dimColor>{desc}</Text>
          </Box>
        ))}
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{"─".repeat(Math.max(10, boxWidth - 6))}</Text>
      </Box>

      <Box flexDirection="column" alignItems="center">
        <Text dimColor>
          Type <Text color="cyan" bold>?</Text> for help  ·  <Text color="cyan" bold>/guide</Text> for manual  ·  Just type to chat
        </Text>
      </Box>
    </Box>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function WelcomeBox({ activeModel, workspacePath }: Props) {
  const { columns } = useTerminalSize();
  const username = userInfo().username;
  const model = activeModel === "Loading..." ? "…" : activeModel;
  const dir = truncatePath(workspacePath.replace(homedir(), "~"), 28);

  if (columns >= 95) {
    return <WideLayout columns={columns} username={username} model={model} dir={dir} />;
  }

  return <CompactLayout columns={columns} username={username} model={model} dir={dir} />;
}
