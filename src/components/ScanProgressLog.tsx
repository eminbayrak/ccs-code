import React from "react";
import { Text, Box } from "ink";

type LineStyle = {
  icon: string;
  iconColor: string;
  textColor: string;
  dim: boolean;
};

function classify(msg: string): LineStyle {
  const m = msg.toLowerCase();

  // Success / completed with confidence
  if (m.includes("analyzed") && m.includes("confidence: high")) {
    return { icon: "✓", iconColor: "#22c55e", textColor: "#22c55e", dim: false };
  }
  if (m.includes("analyzed") && m.includes("confidence: medium")) {
    return { icon: "✓", iconColor: "#f59e0b", textColor: "#f59e0b", dim: false };
  }
  if (m.includes("analyzed") && m.includes("confidence: low")) {
    return { icon: "✓", iconColor: "#ef4444", textColor: "#ef4444", dim: false };
  }
  if (msg.startsWith("✓") || m.includes("written to") || m.includes("commands written") || m.includes("written for codex")) {
    return { icon: "✓", iconColor: "#22c55e", textColor: "#d1fae5", dim: false };
  }

  // Errors / failures
  if (msg.startsWith("✗") || m.includes("failed") || m.includes("error:")) {
    return { icon: "✗", iconColor: "#ef4444", textColor: "#fca5a5", dim: false };
  }

  // Warnings / rate limits
  if (msg.startsWith("⚠") || m.includes("rate limit") || m.includes("could not resolve") || m.includes("unresolved") || m.includes("manual input")) {
    return { icon: "⚠", iconColor: "#f59e0b", textColor: "#fde68a", dim: false };
  }

  // Tool calls — search_github, read_file, search_code
  if (m.match(/^(search_github|read_file|search_code|gh api)\s*[("]/)) {
    return { icon: "⌕", iconColor: "#60a5fa", textColor: "#93c5fd", dim: false };
  }

  // Arrow results — → repo/path or → No results
  if (msg.startsWith("→") || msg.startsWith("  →") || m.startsWith("→") ) {
    const noResults = m.includes("no results") || m.includes("no match");
    return { icon: "→", iconColor: noResults ? "#6b7280" : "#34d399", textColor: noResults ? "#6b7280" : "#d1fae5", dim: noResults };
  }

  // AI Research phase
  if (m.includes("ai research") || m.includes("resolving ")) {
    return { icon: "◈", iconColor: "#38bdf8", textColor: "#e0f2fe", dim: false };
  }

  // AI Analysis phase
  if (m.includes("ai analysis") || m.includes("analyzing service")) {
    return { icon: "◈", iconColor: "#c084fc", textColor: "#f3e8ff", dim: false };
  }

  // Network / fetch / clone
  if (m.includes("fetching") || m.includes("fetch") || m.includes("cloning") || m.includes("clone")) {
    return { icon: "⬇", iconColor: "#60a5fa", textColor: "#dbeafe", dim: false };
  }

  // File reads
  if (m.startsWith("read:") || (m.includes("read:") && m.includes("lines"))) {
    return { icon: "○", iconColor: "#818cf8", textColor: "#c7d2fe", dim: false };
  }

  // File writes
  if (m.startsWith("written:") || m.includes("context/") || m.includes(".md")) {
    return { icon: "✎", iconColor: "#34d399", textColor: "#d1fae5", dim: false };
  }

  // Discovery stats
  if ((m.includes("found") && (m.includes("file") || m.includes("call site") || m.includes("service"))) ||
      m.includes("scanning with plugin") || m.includes("running plugin")) {
    return { icon: "◆", iconColor: "#38bdf8", textColor: "white", dim: false };
  }

  // Methods / rules / db extracted
  if (m.startsWith("methods:") || m.startsWith("rules:") || m.startsWith("db:") || m.startsWith("calls:")) {
    return { icon: "·", iconColor: "#6b7280", textColor: "#9ca3af", dim: true };
  }

  // Sub-items that carry a ◆ (namespace call sites)
  if (msg.startsWith("◆") || m.includes("call site")) {
    return { icon: "◆", iconColor: "#38bdf8", textColor: "#bae6fd", dim: false };
  }

  // Scan complete summary
  if (m.includes("scan complete")) {
    return { icon: "★", iconColor: "#22c55e", textColor: "#86efac", dim: false };
  }

  // Skipped / already done
  if (m.includes("skipping")) {
    return { icon: "–", iconColor: "#6b7280", textColor: "#6b7280", dim: true };
  }

  // Resets / time info (rate limit sub-lines)
  if (m.includes("resets at") || m.includes("continuing scan")) {
    return { icon: " ", iconColor: "#6b7280", textColor: "#6b7280", dim: true };
  }

  return { icon: "·", iconColor: "#4b5563", textColor: "#9ca3af", dim: true };
}

function cleanMessage(msg: string): string {
  // Strip leading ✓/✗/⚠/◆/◈/→ since we render those as icons
  return msg.replace(/^[✓✗⚠◆◈→⌕]\s*/, "").trim();
}

function renderConfidenceLine(text: string, style: LineStyle, isCurrent: boolean) {
  const confMatch = text.match(/^(.*?\(confidence: )(high|medium|low)(\).*)$/i);
  if (!confMatch) return null;
  const confColor = confMatch[2] === "high" ? "#22c55e" : confMatch[2] === "medium" ? "#f59e0b" : "#ef4444";
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={style.iconColor}>{style.icon}</Text>
      <Text color={style.textColor} dimColor={style.dim}>{confMatch[1]}</Text>
      <Text color={confColor} bold>{confMatch[2]}</Text>
      <Text color={style.textColor} dimColor={style.dim}>{confMatch[3]}</Text>
    </Box>
  );
}

const MAX_VISIBLE = 14;

export function ScanProgressLog({ logs }: { logs: string[] }) {
  if (logs.length === 0) return null;

  const visible = logs.filter((l) => l.trim()).slice(-MAX_VISIBLE);

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      {visible.map((log, i) => {
        const isCurrent = i === visible.length - 1;
        const trimmed   = log.trim();
        const isIndented = log.startsWith("  ") || log.startsWith("\t");
        const style     = classify(trimmed);

        const confLine = renderConfidenceLine(cleanMessage(trimmed), style, isCurrent);
        if (confLine) {
          return (
            <Box key={i} paddingLeft={isIndented ? 3 : 0}>
              {confLine}
            </Box>
          );
        }

        return (
          <Box key={i} paddingLeft={isIndented ? 3 : 0} flexDirection="row" gap={1}>
            <Text color={isCurrent ? style.iconColor : style.iconColor} dimColor={style.dim && !isCurrent}>
              {style.icon}
            </Text>
            <Text
              color={isCurrent ? "white" : style.textColor}
              dimColor={style.dim && !isCurrent}
              bold={isCurrent && !style.dim}
            >
              {cleanMessage(trimmed)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
