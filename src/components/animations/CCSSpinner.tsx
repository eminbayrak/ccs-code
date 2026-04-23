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
  const [label] = useState(() => {
    const pool = isStalled ? STALLED_LABELS : THINKING_LABELS;
    return pool[Math.floor(Math.random() * pool.length)]!;
  });

  useEffect(() => {
    const frameTimer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 120);
    return () => clearInterval(frameTimer);
  }, []);

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={isStalled ? "red" : "green"}>{FRAMES[frame]}</Text>
      <ShimmerText text={label} />
    </Box>
  );
}
