import React from "react";
import { Text, Box } from "ink";

// Claude Code style: "⎿  tool name" indented, no progress bar
export function AgentProgressLine({ taskName, isComplete = false }: { taskName: string; isComplete?: boolean }) {
  return (
    <Box flexDirection="row">
      <Text dimColor>{"  ⎿  "}</Text>
      <Text color={isComplete ? "green" : "white"} dimColor={isComplete}>
        {taskName}
      </Text>
    </Box>
  );
}
