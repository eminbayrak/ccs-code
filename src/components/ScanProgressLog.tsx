import React from "react";
import { Text, Box } from "ink";

// ---------------------------------------------------------------------------
// Classify each log line from tracer.ts into a visual style
// ---------------------------------------------------------------------------

type LineStyle = {
  icon: string;
  iconColor: string;
  textColor: string;
  dim: boolean;
};

function classify(msg: string): LineStyle {
  const m = msg.toLowerCase();

  // Success / completed
  if (msg.startsWith("✓") || (m.includes("analyzed") && m.includes("confidence: high"))) {
    return { icon: "✓", iconColor: "#22c55e", textColor: "#22c55e", dim: false };
  }
  if (m.includes("analyzed") && m.includes("confidence: medium")) {
    return { icon: "✓", iconColor: "#f59e0b", textColor: "#f59e0b", dim: false };
  }
  if (m.includes("analyzed") && m.includes("confidence: low")) {
    return { icon: "✓", iconColor: "#f97316", textColor: "#f97316", dim: false };
  }
  if (msg.startsWith("✓") || m.includes("written to") || m.includes("commands written") || m.includes("written for codex")) {
    return { icon: "✓", iconColor: "#22c55e", textColor: "#d1fae5", dim: false };
  }

  // Errors / failures
  if (msg.startsWith("✗") || m.includes("failed") || m.includes("error:")) {
    return { icon: "✗", iconColor: "#ef4444", textColor: "#fca5a5", dim: false };
  }

  // Warnings / unresolved
  if (m.includes("could not resolve") || m.includes("unresolved") || m.includes("manual input")) {
    return { icon: "⚠", iconColor: "#f59e0b", textColor: "#fde68a", dim: false };
  }

  // AI Research phase
  if (m.includes("ai research") || m.includes("searching for")) {
    return { icon: "◈", iconColor: "#38bdf8", textColor: "#e0f2fe", dim: false };
  }

  // AI Analysis phase
  if (m.includes("ai analysis") || m.includes("analyzing service")) {
    return { icon: "◈", iconColor: "#c084fc", textColor: "#f3e8ff", dim: false };
  }

  // Network / fetch
  if (m.includes("fetching") || m.includes("fetch")) {
    return { icon: "⬇", iconColor: "#60a5fa", textColor: "#dbeafe", dim: false };
  }

  // Discovery stats
  if (
    (m.includes("found") && (m.includes("file") || m.includes("call site") || m.includes("service"))) ||
    m.includes("scanning with plugin")
  ) {
    return { icon: "◆", iconColor: "#38bdf8", textColor: "white", dim: false };
  }

  // Scan complete summary
  if (m.includes("scan complete")) {
    return { icon: "★", iconColor: "#22c55e", textColor: "#86efac", dim: false };
  }

  // Skipped
  if (m.includes("skipping")) {
    return { icon: "–", iconColor: "#6b7280", textColor: "#6b7280", dim: true };
  }

  // Default info
  return { icon: "·", iconColor: "#4b5563", textColor: "#9ca3af", dim: true };
}

// ---------------------------------------------------------------------------
// Strip leading ✓ / ✗ from message since we render those as icons
// Also trim blank lines
// ---------------------------------------------------------------------------

function cleanMessage(msg: string): string {
  return msg.replace(/^[✓✗]\s*/, "").trim();
}

// ---------------------------------------------------------------------------
// Render a confidence badge inline
// "confidence: high" → colored tag
// ---------------------------------------------------------------------------

function renderLine(msg: string, style: LineStyle, isCurrent: boolean) {
  const text = cleanMessage(msg);

  // Highlight confidence level in analyzed messages
  const confMatch = text.match(/^(.*?\(confidence: )(high|medium|low)(\).*)$/i);
  if (confMatch) {
    const confColor = confMatch[2] === "high" ? "#22c55e" : confMatch[2] === "medium" ? "#f59e0b" : "#ef4444";
    return (
      <Box flexDirection="row" gap={1}>
        <Text color={style.iconColor}>{style.icon}</Text>
        <Text color={style.textColor} dimColor={style.dim}>
          {confMatch[1]}
        </Text>
        <Text color={confColor} bold>{confMatch[2]}</Text>
        <Text color={style.textColor} dimColor={style.dim}>
          {confMatch[3]}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={style.iconColor}>{style.icon}</Text>
      <Text color={isCurrent ? "white" : style.textColor} dimColor={style.dim} bold={isCurrent}>
        {text}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Public component — renders the last N log lines with colors
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 12;

export function ScanProgressLog({ logs }: { logs: string[] }) {
  if (logs.length === 0) return null;

  const visible = logs.filter((l) => l.trim()).slice(-MAX_VISIBLE);

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      {visible.map((log, i) => {
        const isCurrent = i === visible.length - 1;
        const isDetail = log.startsWith("  ") || log.startsWith("\t");

        if (isDetail) {
          // Indented detail lines — no icon, dimmer, show as sub-item
          return (
            <Box key={i} paddingLeft={3} flexDirection="row" gap={1}>
              <Text color="#4b5563">│</Text>
              <Text color={isCurrent ? "#d1d5db" : "#6b7280"} dimColor={!isCurrent}>
                {log.trim()}
              </Text>
            </Box>
          );
        }

        const style = classify(log);
        return (
          <Box key={i}>
            {renderLine(log, style, isCurrent)}
          </Box>
        );
      })}
    </Box>
  );
}
