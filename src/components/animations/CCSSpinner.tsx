import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";
import { ShimmerText } from "./ShimmerText.js";

const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];

const THINKING_LABELS = [
  "Thinkering…",
  "Incubating…",
  "Pondering…",
  "Roosting…",
  "Considering…",
  "Brewing…",
  "Synthesizing…",
  "Stewing…",
  "Shimmying…",
  "Spelunking…",
  "Boondoggling…",
  "Snoozing…",
  "Caramelizing…",
  "Osmosing…",
  "Ramening…",
  "Whatchamacalling…",
];

const STALLED_LABELS = [
  "Thinking deeply…",
  "Still working…",
  "Almost there…",
  "Crunching hard…",
];

export function CCSSpinner({ isStalled = false }: { isStalled?: boolean }) {
  const [frame, setFrame] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [label] = useState(() => {
    const pool = isStalled ? STALLED_LABELS : THINKING_LABELS;
    return pool[Math.floor(Math.random() * pool.length)]!;
  });

  useEffect(() => {
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
  }, []);

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={isStalled ? "#ef4444" : "#d97706"}>{FRAMES[frame]}</Text>
      <Box flexDirection="row" gap={1}>
        <ShimmerText text={label} color={isStalled ? "#ef4444" : "#d97706"} />
        <Text dimColor>({formatTime(seconds)})</Text>
      </Box>
    </Box>
  );
}
