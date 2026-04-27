import React, { useEffect, useMemo, useState } from "react";
import { Text, Box } from "ink";
import { GlowDot } from "./animations/GlowDot";

type StepTone = "done" | "active" | "warn" | "error" | "info" | "summary";

type ProgressStep = {
  message: string;
  tone: StepTone;
  isNested?: boolean;
};

const MAX_VISIBLE = 8;
const ACCENT = "#63b3ed"; // Gemini-style bright blue
const MUTED = "#4a5568";

function normalizeMessage(msg: string): string {
  // Same normalization as before but geared towards the new aesthetic
  return msg
    .replace(/^[✓✗⚠·●◆◇◈]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/\.\.\.$/, "")
    .trim();
}

function classify(raw: string, isLast: boolean, isActive: boolean): StepTone {
  const msg = raw.toLowerCase();
  if (msg.includes("✗") || msg.includes("error:")) return "error";
  if (msg.includes("⚠") || msg.includes("warning")) return "warn";
  // The summary line often has complexity/confidence info
  if (msg.includes("verdict=")) return "summary";
  if (isLast && isActive) return "active";
  return "done";
}

function prepareSteps(logs: string[], isActive: boolean): ProgressStep[] {
  const steps: ProgressStep[] = [];
  
  for (const raw of logs) {
    if (!raw.trim()) continue;
    const message = normalizeMessage(raw);
    const isNested = message.startsWith("Analyzing") || message.startsWith("Verifying") || message.includes("complexity");
    
    steps.push({
      message,
      tone: classify(raw, false, isActive),
      isNested
    });
  }

  // Mark the actual last step as active if we are still processing
  if (steps.length > 0 && isActive) {
    steps[steps.length - 1]!.tone = "active";
  }

  return steps;
}

function StepLine({ step, width, isLast }: { step: ProgressStep; width: number; isLast?: boolean }) {
  const isSummary = step.tone === "summary";
  const isActive = step.tone === "active";
  const isDone = step.tone === "done";
  
  let color = isDone ? MUTED : "#e2e8f0";
  if (isActive) color = "#ffffff";
  if (isSummary) color = ACCENT;
  if (step.tone === "error") color = "#f56565";

  const bullet = isSummary ? "*" : isActive ? "●" : isDone ? "●" : "·";
  
  return (
    <Box flexDirection="row" gap={1} paddingLeft={step.isNested ? 2 : 1}>
      {isActive ? (
        <GlowDot active={true} />
      ) : (
        <Text color={isDone ? MUTED : color}>{bullet}</Text>
      )}
      <Text
        color={color}
        bold={isActive || isSummary}
        wrap="truncate-end"
      >
        {step.message}
      </Text>
    </Box>
  );
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
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  
  return (
    <Box flexDirection="row" gap={1} marginBottom={1} paddingLeft={1}>
      <GlowDot active={active} color={active ? "#63b3ed" : "#718096"} />
      <Text color="#ffffff" bold={active}>
        {active ? "Working" : "Finished"}
      </Text>
      <Text color={MUTED}>
        ({timeStr} · {modelLabel}{active ? " · esc to interrupt" : ""})
      </Text>
    </Box>
  );
}

export function ScanProgressLog({
  logs,
  isExpanded = false,
  showSpinnerForLast = true,
  modelLabel = "Gemini",
  width = 100,
}: {
  logs: string[];
  isExpanded?: boolean;
  showSpinnerForLast?: boolean;
  modelLabel?: string;
  width?: number;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!showSpinnerForLast) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [showSpinnerForLast]);

  const steps = useMemo(() => prepareSteps(logs, showSpinnerForLast), [logs, showSpinnerForLast]);
  if (steps.length === 0) return null;

  const hiddenCount = Math.max(0, steps.length - MAX_VISIBLE);
  const visible = isExpanded ? steps : steps.slice(-MAX_VISIBLE);
  const lineWidth = Math.max(36, width - 4);

  return (
    <Box flexDirection="column" marginBottom={1} marginTop={1}>
      <ProgressHeader active={showSpinnerForLast} elapsed={elapsed} modelLabel={modelLabel} />
      
      <Box flexDirection="column" gap={0} paddingLeft={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={MUTED}>
        {!isExpanded && hiddenCount > 0 && (
          <Box flexDirection="row" gap={1} paddingLeft={1}>
            <Text color={MUTED}>·</Text>
            <Text color={MUTED} italic>
              {hiddenCount} earlier steps hidden · ctrl+o to expand
            </Text>
          </Box>
        )}
        {visible.map((step, index) => (
          <StepLine 
            key={`${step.message}-${index}`} 
            step={step} 
            width={lineWidth}
            isLast={index === visible.length - 1} 
          />
        ))}
      </Box>

      {!showSpinnerForLast && (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={ACCENT} bold>✓ Migration analysis complete</Text>
        </Box>
      )}
    </Box>
  );
}
