import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";
import { ShimmerText } from "./ShimmerText.js";

const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];

const THINKING_LABELS = [
  "Thinking…",
  "Analyzing…",
  "Synthesizing…",
  "Checking evidence…",
  "Building context…",
  "Preparing handoff…",
];

const STALLED_LABELS = [
  "Thinking deeply…",
  "Still working…",
  "Almost there…",
  "Crunching…",
];

export function CCSSpinner({ isStalled = false, label: overrideLabel }: { isStalled?: boolean; label?: string }) {
  const [frame, setFrame] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [label] = useState(() => {
    const pool = isStalled ? STALLED_LABELS : THINKING_LABELS;
    return pool[Math.floor(Math.random() * pool.length)]!;
  });

  const activeLabel = overrideLabel ?? label;
  const isThinkingLabel = !overrideLabel;
  const baseColor = isStalled ? "red" : "cyan";

  useEffect(() => {
    if (!isThinkingLabel) return;

    const frameTimer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 120);

    const elapsedTimer = setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);

    return () => {
      clearInterval(frameTimer);
      clearInterval(elapsedTimer);
    };
  }, [isThinkingLabel]);

  const formatTime = (s: number) => {
    if (s < 60) return `${s}s`;
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={baseColor} bold>
        {isThinkingLabel ? FRAMES[frame] : "·"}
      </Text>
      <Box flexDirection="row" gap={1}>
        {isThinkingLabel ? (
          <ShimmerText text={activeLabel} color={baseColor} />
        ) : (
          <Text color={baseColor}>{activeLabel}</Text>
        )}
        {isThinkingLabel && <Text dimColor>({formatTime(seconds)})</Text>}
      </Box>
    </Box>
  );
}
