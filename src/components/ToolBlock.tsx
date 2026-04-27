import React from "react";
import { Box, Text } from "ink";

type ToolBlockProps = {
  name: string;
  description?: string;
  icon?: string;
  status: string;
  details?: string;
  isComplete: boolean;
  width: number;
};

const SUCCESS = "#48bb78";
const MUTED   = "#718096";
const DIM     = "#2d3748";

// Contextual icons for known tool types — safe Unicode, no Nerd Fonts needed
const TOOL_ICONS: Record<string, string> = {
  // Vault / knowledge
  "Source Syncer":     "⇅",
  "Ingestor":          "⎘",
  "AI Analysis":       "◈",
  "WikiSearch":        "⌕",
  "Graph Builder":     "⬡",
  "Index Builder":     "☰",
  "Lint":              "✦",
  "Guide":             "◉",
  // Migration
  "Migration Scanner": "⏣",
  "Code Analyzer":     "⌬",
  "Status Reporter":   "▣",
  "Context Builder":   "⊞",
  "Claim Verifier":    "⊛",
  "Finalizer":         "⊕",
  "Plugin Loader":     "⊗",
  "Migration Tool":    "⬡",
  // LLM
  "Harvest":           "⊡",
};

function getIcon(name: string): string {
  // Exact match first
  if (TOOL_ICONS[name]) return TOOL_ICONS[name]!;
  // Partial match
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return icon;
  }
  return "●";
}

export function ToolBlock({
  name,
  description,
  icon,
  status,
  details,
  isComplete,
  width,
}: ToolBlockProps) {
  const displayIcon = icon || (isComplete ? "✓" : getIcon(name));
  const cardWidth = Math.min(width, 96);
  const statusColor = isComplete ? SUCCESS : "#63b3ed";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isComplete ? "#2d4a2d" : DIM}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      width={cardWidth}
    >
      {/* Header: icon  Name   status/description */}
      <Box flexDirection="row" gap={1}>
        <Text color={statusColor} bold>{displayIcon}</Text>
        <Text bold color="#e2e8f0">{name}</Text>
        <Text color={MUTED} dimColor>
          {description ? description : status}
        </Text>
      </Box>

      {/* Details sub-row — only shown while working or when there's a message */}
      {!isComplete && details && (
        <Box marginLeft={2} marginTop={0}>
          <Text color={MUTED} wrap="truncate-end">
            {"└ "}{details}
          </Text>
        </Box>
      )}
    </Box>
  );
}
