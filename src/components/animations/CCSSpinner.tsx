import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

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
  const [labelIdx, setLabelIdx] = useState(0);

  useEffect(() => {
    const frameTimer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 120);
    return () => clearInterval(frameTimer);
  }, []);

  useEffect(() => {
    const labelTimer = setInterval(() => {
      setLabelIdx((i) => {
        const pool = isStalled ? STALLED_LABELS : THINKING_LABELS;
        return (i + 1) % pool.length;
      });
    }, 2500);
    return () => clearInterval(labelTimer);
  }, [isStalled]);

  const pool = isStalled ? STALLED_LABELS : THINKING_LABELS;
  const label = pool[labelIdx % pool.length];

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={isStalled ? "red" : "green"}>{FRAMES[frame]}</Text>
      <Text dimColor>{label}</Text>
    </Box>
  );
}
