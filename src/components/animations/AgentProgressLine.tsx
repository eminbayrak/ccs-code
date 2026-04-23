import React from "react";
import { Text, Box } from "ink";

export function AgentProgressLine({ taskName, isComplete = false }: { taskName: string; isComplete?: boolean }) {
  const nameLower = taskName.toLowerCase();
  
  // Pick icon based on task
  let icon = "⎿";
  let iconColor = "gray";

  if (nameLower.includes("fetch") || nameLower.includes("pull")) {
    icon = "⬇";
    iconColor = "blue";
  } else if (nameLower.includes("scan") || nameLower.includes("search")) {
    icon = "🔍";
    iconColor = "cyan";
  } else if (nameLower.includes("analyz") || nameLower.includes("processing")) {
    icon = "🧠";
    iconColor = "magenta";
  } else if (nameLower.includes("resolv") || nameLower.includes("linking")) {
    icon = "🔗";
    iconColor = "yellow";
  } else if (nameLower.includes("write") || nameLower.includes("rewrite")) {
    icon = "📝";
    iconColor = "green";
  }

  if (isComplete) {
    icon = "✓";
    iconColor = "green";
  }

  return (
    <Box flexDirection="row" paddingLeft={2}>
      <Text color={iconColor}>{icon}  </Text>
      <Text color={isComplete ? "green" : "white"} dimColor={isComplete}>
        {taskName}
      </Text>
    </Box>
  );
}
