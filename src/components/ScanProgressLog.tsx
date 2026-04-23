import React from "react";
import { Text, Box } from "ink";
import { CCSSpinner } from "./animations/CCSSpinner.js";

type LineStyle = {
  icon: string;
  iconColor: string;
  textColor: string;
  dim: boolean;
};

function classify(msg: string): LineStyle {
  const m = msg.toLowerCase();

  // Success / completed
  if (msg.startsWith("✓") || m.includes("analyzed") || m.includes("written") || m.includes("complete")) {
    return { icon: "✓", iconColor: "#22c55e", textColor: "#9ca3af", dim: true };
  }

  // Errors / failures
  if (msg.startsWith("✗") || m.includes("failed") || m.includes("error:")) {
    return { icon: "✗", iconColor: "#ef4444", textColor: "#fca5a5", dim: false };
  }

  // Warnings / rate limits
  if (msg.startsWith("⚠") || m.includes("rate limit")) {
    return { icon: "⚠", iconColor: "#f59e0b", textColor: "#fde68a", dim: false };
  }

  // Default / Active
  return { icon: "·", iconColor: "#d1d5db", textColor: "#f3f4f6", dim: false };
}

function cleanMessage(msg: string): string {
  return msg.replace(/^[✓✗⚠◆◈→⌕·]\s*/, "").trim();
}

const MAX_VISIBLE = 12;

export function ScanProgressLog({ logs }: { logs: string[] }) {
  if (logs.length === 0) return null;

  // Deduplicate heartbeat logs: only show the latest "Searching GitHub for..."
  const processedLogs: string[] = [];
  for (const log of logs) {
    if (log.includes("Searching GitHub for")) {
      const prefix = log.split("...")[0] + "...";
      const lastIdx = processedLogs.findIndex(l => l.startsWith(prefix));
      if (lastIdx !== -1) {
        processedLogs[lastIdx] = log;
        continue;
      }
    }
    processedLogs.push(log);
  }

  const visible = processedLogs.slice(-MAX_VISIBLE);

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      {visible.map((log, i) => {
        const isLast = i === visible.length - 1;
        const trimmed = log.trim();
        const isIndented = log.startsWith("  ") || log.startsWith("\t");
        const style = classify(trimmed);
        const isComplete = style.icon === "✓" || style.icon === "★";

        return (
          <Box key={i} paddingLeft={isIndented ? 2 : 0} flexDirection="row" gap={1}>
            {isLast && !isComplete ? (
              <CCSSpinner label={cleanMessage(trimmed)} />
            ) : (
              <>
                <Text color={style.iconColor} dimColor={style.dim}>
                  {style.icon}
                </Text>
                <Text color={style.textColor} dimColor={style.dim}>
                  {cleanMessage(trimmed)}
                </Text>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
