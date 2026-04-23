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

  // Research / Analysis headers
  if (m.startsWith("ai research")) {
    return { icon: "●", iconColor: "cyan", textColor: "cyan", dim: false };
  }
  if (m.startsWith("ai analysis")) {
    return { icon: "●", iconColor: "magenta", textColor: "magenta", dim: false };
  }

  // Tool / Command starts
  if (m.startsWith("bash") || m.startsWith("searching") || m.startsWith("reading") || m.startsWith("resolving")) {
    return { icon: "●", iconColor: "green", textColor: "white", dim: false };
  }

  // Success / completed
  if (msg.includes("✓") || m.includes("analyzed") || m.includes("written") || m.includes("complete")) {
    return { icon: "✓", iconColor: "green", textColor: "gray", dim: true };
  }

  // Errors / failures
  if (msg.includes("✗") || m.includes("failed") || m.includes("error:")) {
    return { icon: "✗", iconColor: "red", textColor: "red", dim: false };
  }

  // Warnings / rate limits
  if (msg.includes("⚠") || m.includes("rate limit") || m.includes("low")) {
    return { icon: "⚠", iconColor: "yellow", textColor: "yellow", dim: false };
  }

  // Default / Active
  return { icon: "·", iconColor: "cyan", textColor: "white", dim: false };
}

function cleanMessage(msg: string): string {
  return msg.replace(/^[✓✗⚠·●]\s*/, "").trim();
}

function CollapsibleLog({ log, style, indent, isExpanded }: { log: string; style: LineStyle; indent: number; isExpanded: boolean }) {
  const MAX_LINES = 3;
  const lines = log.split("\n");
  const isLong = lines.length > MAX_LINES;
  const displayLines = (isLong && !isExpanded) ? lines.slice(0, MAX_LINES) : lines;

  return (
    <Box flexDirection="column" marginLeft={indent > 0 ? 0 : 0}>
      <Box flexDirection="row" gap={1}>
        <Text color={style.iconColor} dimColor={style.dim}>
          {indent > 0 ? "  ⎿" : style.icon}
        </Text>
        <Box flexDirection="column">
          {displayLines.map((line, i) => (
            <Text key={i} color={style.textColor} dimColor={style.dim} bold={i === 0 && indent === 0}>
              {cleanMessage(line)}
            </Text>
          ))}
          {isLong && !isExpanded && (
            <Text dimColor italic>
              {`   … +${lines.length - MAX_LINES} lines (ctrl+o to expand)`}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

const MAX_VISIBLE = 12;

export function ScanProgressLog({ logs, isExpanded = false }: { logs: string[]; isExpanded?: boolean }) {
  if (logs.length === 0) return null;

  // Aggressive deduplication and cleaning
  const processedLogs: string[] = [];
  for (const log of logs) {
    let msg = log;

    // 1. Summarize verbose GitHub/Gemini errors (keep a bit more detail for expansion)
    if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded")) {
      const match = msg.match(/retry in ([^\\n.]+)/);
      const time = match ? match[1] : "later";
      msg = `✗ LLM Daily Quota Exhausted (Retry in ${time})\n${msg}`;
    }

    // 2. Deduplicate "Thinking/Searching" heartbeats
    const heartbeatPatterns = [
      "Searching GitHub for",
      "Analyzing",
      "Thinking",
      "Researching",
      "Resolving"
    ];
    
    let isHeartbeat = false;
    for (const p of heartbeatPatterns) {
      if (msg.includes(p)) {
        const prefix = msg.split("...")[0] + "...";
        const lastIdx = processedLogs.findIndex(l => l.includes(prefix));
        if (lastIdx !== -1) {
          processedLogs[lastIdx] = msg;
          isHeartbeat = true;
          break;
        }
      }
    }

    if (!isHeartbeat) {
      processedLogs.push(msg);
    }
  }

  // Only show the most relevant logs to keep it compact
  const visible = processedLogs.slice(-MAX_VISIBLE);

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      {visible.map((log, i) => {
        const isLast = i === visible.length - 1;
        const indentLevel = log.match(/^(\s*)/)?.[0].length || 0;
        const style = classify(log.trim());
        const isComplete = style.icon === "✓" || style.icon === "★";

        if (isLast && !isComplete && !log.includes("✗")) {
          return <CCSSpinner key={i} label={cleanMessage(log.trim())} />;
        }

        return (
          <CollapsibleLog
            key={i}
            log={log.trim()}
            style={style}
            indent={indentLevel}
            isExpanded={isExpanded}
          />
        );
      })}
    </Box>
  );
}
