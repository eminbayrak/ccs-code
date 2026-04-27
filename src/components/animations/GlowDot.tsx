import React, { useState, useEffect } from "react";
import { Text } from "ink";

type Props = {
  active?: boolean;
  color?: string;
  glowColor?: string;
};

export function GlowDot({ active = true, color = "#63b3ed", glowColor = "#4299e1" }: Props) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setPhase((p) => (p + 1) % 20);
    }, 100);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return <Text color="#718096">●</Text>;
  }

  // Simulate a pulse by alternating between core color and glow color
  // Phase 0-10: brightening, 10-20: dimming
  const isGlowing = phase > 5 && phase < 15;
  
  return (
    <Text color={isGlowing ? glowColor : color} bold={isGlowing}>
      ●
    </Text>
  );
}
