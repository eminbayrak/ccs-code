import React, { useEffect, useMemo, useState } from "react";
import { Text, Box } from "ink";

type StepTone = "done" | "active" | "warn" | "error" | "info";

type ProgressStep = {
  message: string;
  tone: StepTone;
};

const MAX_VISIBLE = 8;

const SPINNER_FRAMES = ["✶", "✷", "✸", "✹"];
const ACCENT = "#8ab4f8";

function cleanMessage(msg: string): string {
  return msg
    .replace(/^[✓✗⚠·●◆◇◈]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/\.\.\.$/, "")
    .trim();
}

function normalizeMessage(msg: string): string {
  const clean = cleanMessage(msg);
  return clean
    .replace(/^Detected:\s*/i, "Detected ")
    .replace(/^Found\s+(\d+)\s+files\s+in\s+repo\.?$/i, "Indexed $1 repository files")
    .replace(/^Found\s+(\d+)\s+components\s+\(excluding tests\)\.?$/i, "Discovered $1 migration components")
    .replace(/^Loaded\s+(\d+)\s+modernization context doc\(s\)\.?$/i, "Loaded $1 architecture context docs")
    .replace(/^No modernization context docs found; using the default architecture profile\.?$/i, "Using default architecture profile")
    .replace(/^Fetching file tree from\s+/i, "Reading repository tree from ")
    .replace(/^Detecting source framework\.?$/i, "Detecting framework and target shape")
    .replace(/^Discovering components\.?$/i, "Discovering migration components")
    .replace(/^Generating migration knowledge base index\.?$/i, "Building run README and index")
    .replace(/^Generating AI tool integration files\.?$/i, "Writing agent handoff files")
    .replace(/^Verifying claims for\s+/i, "Verifying source-backed claims for ")
    .replace(/^Re-verifying revised claims for\s+/i, "Re-verifying revised claims for ")
    .replace(/^Revising\s+/i, "Revising ")
    .replace(/^Analyzing\s+/i, "Analyzing ");
}

function compactKey(msg: string): string {
  const clean = normalizeMessage(msg).toLowerCase();
  if (clean.startsWith("analyzing ")) return "analyzing-component";
  if (clean.startsWith("verifying source-backed claims for ")) return "verifying-component";
  if (clean.startsWith("revising ")) return "revising-component";
  if (clean.startsWith("re-verifying revised claims for ")) return "reverifying-component";
  return clean.replace(/\d+/g, "#");
}

function classify(raw: string, isLast: boolean, showSpinnerForLast: boolean): StepTone {
  const msg = raw.toLowerCase();
  if (msg.includes("✗") || msg.includes("failed") || msg.includes("error:") || msg.includes("crashed")) {
    return "error";
  }
  if (msg.includes("⚠") || msg.includes("warning") || msg.includes("rate limit") || msg.includes("low confidence")) {
    return "warn";
  }
  if (isLast && showSpinnerForLast && !raw.includes("✓")) {
    return "active";
  }
  if (
    raw.includes("✓") ||
    msg.includes(" complete") ||
    msg.includes("written") ||
    msg.includes("discovered") ||
    msg.includes("detected") ||
    msg.includes("found ") ||
    msg.includes("loaded ") ||
    msg.includes("indexed ") ||
    msg.includes("using default")
  ) {
    return "done";
  }
  return isLast && showSpinnerForLast ? "active" : "done";
}

function prepareSteps(logs: string[], showSpinnerForLast: boolean): ProgressStep[] {
  const deduped: string[] = [];
  const keyToIndex = new Map<string, number>();

  for (const raw of logs) {
    if (!raw.trim()) continue;
    let msg = raw;
    if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded")) {
      const match = msg.match(/retry in ([^\\n.]+)/);
      msg = `✗ LLM quota exhausted${match ? ` — retry in ${match[1]}` : ""}`;
    }

    const display = normalizeMessage(msg);
    const key = compactKey(display);
    const existing = keyToIndex.get(key);
    if (existing !== undefined) {
      deduped[existing] = display;
    } else {
      keyToIndex.set(key, deduped.length);
      deduped.push(display);
    }
  }

  return deduped.map((message, index) => ({
    message,
    tone: classify(message, index === deduped.length - 1, showSpinnerForLast),
  }));
}

function toneColor(tone: StepTone): string {
  if (tone === "done") return "#7f8797";
  if (tone === "active") return ACCENT;
  if (tone === "warn") return "yellow";
  if (tone === "error") return "red";
  return "#7f8797";
}

function toneIcon(tone: StepTone, frame: number): string {
  if (tone === "done") return "●";
  if (tone === "warn") return "!";
  if (tone === "error") return "✕";
  if (tone === "active") return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "◆";
  return "●";
}

function truncateEnd(value: string, max: number): string {
  if (max <= 1) return value.slice(0, max);
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

function ProgressHeader({
  active,
  elapsed,
  modelLabel,
}: {
  active: boolean;
  elapsed: number;
  modelLabel: string;
}) {
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const model = modelLabel === "Loading..." ? "model loading" : modelLabel;
  return (
    <Box flexDirection="row" gap={1} marginBottom={1} paddingLeft={1}>
      <Text color={active ? "#aeb7d6" : "#7f8797"}>●</Text>
      <Text color="#c8d1f0" bold={active}>
        {active ? "Working" : "Finished"}
      </Text>
      <Text color="#737b8f">
        ({label} · {model}{active ? " · esc to interrupt" : ""})
      </Text>
    </Box>
  );
}

function StepLine({ step, frame, width }: { step: ProgressStep; frame: number; width: number }) {
  const color = toneColor(step.tone);
  const dim = step.tone === "done" || step.tone === "info";
  const message = truncateEnd(step.message, Math.max(20, width - 5));
  return (
    <Box flexDirection="row" gap={1} paddingLeft={1}>
      <Text color={color} bold={!dim}>
        {toneIcon(step.tone, frame)}
      </Text>
      <Text
        color={step.tone === "active" ? ACCENT : color}
        dimColor={dim}
        bold={step.tone === "active"}
        wrap="truncate-end"
      >
        {message}
      </Text>
    </Box>
  );
}

export function ScanProgressLog({
  logs,
  isExpanded = false,
  showSpinnerForLast = true,
  modelLabel = "migration",
  width = 100,
}: {
  logs: string[];
  isExpanded?: boolean;
  showSpinnerForLast?: boolean;
  modelLabel?: string;
  width?: number;
}) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!showSpinnerForLast) return;
    const frameTimer = setInterval(() => setFrame((value) => value + 1), 160);
    const elapsedTimer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => {
      clearInterval(frameTimer);
      clearInterval(elapsedTimer);
    };
  }, [showSpinnerForLast]);

  const steps = useMemo(() => prepareSteps(logs, showSpinnerForLast), [logs, showSpinnerForLast]);
  if (steps.length === 0) return null;

  const hidden = Math.max(0, steps.length - MAX_VISIBLE);
  const visible = isExpanded ? steps : steps.slice(-MAX_VISIBLE);
  const lineWidth = Math.max(36, width - 4);

  return (
    <Box flexDirection="column" marginBottom={1} marginTop={1}>
      <ProgressHeader active={showSpinnerForLast} elapsed={elapsed} modelLabel={modelLabel} />
      <Box flexDirection="column" gap={0}>
        {!isExpanded && hidden > 0 && (
          <Box flexDirection="row" gap={1} paddingLeft={1}>
            <Text color="#737b8f">·</Text>
            <Text color="#737b8f">
              {hidden} earlier steps hidden · ctrl+o to expand
            </Text>
          </Box>
        )}
        {visible.map((step, index) => (
          <StepLine key={`${step.message}-${index}`} step={step} frame={frame} width={lineWidth} />
        ))}
      </Box>
    </Box>
  );
}
