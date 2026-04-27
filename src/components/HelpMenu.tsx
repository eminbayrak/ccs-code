import React from "react";
import { Box, Text } from "ink";
import { platform } from "os";

export function HelpMenu({ terminalWidth }: { terminalWidth?: number }) {
  const isWindows = platform() === "win32";
  const width = terminalWidth ?? process.stdout.columns ?? 120;
  const narrow = width < 100;

  const col1 = [
    ["@file", "attach file to message"],
    ["/cmd", "run a slash command"],
    ["/m", "show migration commands"],
    ["?", "toggle this menu"],
    ["↑↓", "navigate suggestions"],
    ["Tab", "accept suggestion"],
    ["Esc", "cancel suggestion"],
  ];

  const col2 = [
    ["/vault init", "create knowledge base"],
    ["/sync", "sync GitHub sources"],
    ["/ingest", "process raw/ inbox"],
    ["/graph", "build knowledge graph"],
    ["/lint", "wiki health check"],
    ["/migrate rewrite", "analyze legacy repo"],
    ["/migrate open", "open latest results"],
    ["/rewrite <svc>", "rewrite brief"],
    ["/index", "rebuild master index"],
  ];

  const col3 = [
    ["/clear", "clear history"],
    ["/skills", "list skills"],
    ["/guide", "full command reference"],
    ["/setup", "MCP setup"],
    ["/model", "active model"],
    ["/mode <mode>", "default · plan · permissive"],
    ["/approvals", "pending approvals"],
    ["/tasks", "background tasks"],
    ["/hooks list", "event hooks"],
    ["/exit", !isWindows ? "exit  (or ctrl+c)" : "exit"],
  ];

  const renderCol = (rows: string[][], colWidth?: number, keyWidth = 14) => (
    <Box flexDirection="column" width={colWidth} marginRight={2}>
      {rows.map(([key, desc]) => (
        <Box key={key} flexDirection="row">
          <Box width={keyWidth} flexShrink={0}>
            <Text bold color="white" wrap="truncate-end">{key}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">{desc}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );

  return (
    <Box paddingX={2} marginTop={1} flexDirection={narrow ? "column" : "row"}>
      {renderCol(col1, narrow ? undefined : 28, 10)}
      {renderCol(col2, narrow ? undefined : 34, 18)}
      {renderCol(col3, undefined, 14)}
    </Box>
  );
}
