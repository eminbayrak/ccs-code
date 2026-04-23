import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

export function ShimmerText({ text, color = "#9ca3af" }: { text: string; color?: string }) {
  const [offset, setOffset] = useState(-10);

  useEffect(() => {
    const interval = setInterval(() => {
      setOffset((o) => {
        if (o >= text.length + 10) return -10;
        return o + 1;
      });
    }, 45); // Faster, smoother sliding
    return () => clearInterval(interval);
  }, [text.length]);

  return (
    <Box flexDirection="row">
      {text.split("").map((char, i) => {
        const dist = i - offset;
        let charColor = color;
        let bold = false;

        // Claude-style shimmer: subtle brightness wave
        if (dist >= 0 && dist <= 4) {
          if (dist === 2) {
            charColor = "white";
            bold = true;
          } else if (dist === 1 || dist === 3) {
            charColor = "white";
            bold = false;
          }
        }

        return (
          <Text key={i} color={charColor} bold={bold}>
            {char}
          </Text>
        );
      })}
    </Box>
  );
}
