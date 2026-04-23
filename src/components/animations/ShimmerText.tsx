import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

export function ShimmerText({ text }: { text: string; }) {
  const [offset, setOffset] = useState(-5);

  useEffect(() => {
    const interval = setInterval(() => {
      setOffset((o) => {
        if (o >= text.length + 5) return -5;
        return o + 1;
      });
    }, 60); // Sliding speed
    return () => clearInterval(interval);
  }, [text.length]);

  return (
    <Box flexDirection="row">
      {text.split("").map((char, i) => {
        // Highlight is 4 characters wide with different intensities
        const dist = i - offset;
        let color = "gray";
        let bold = false;

        if (dist === 0 || dist === 3) {
          color = "white";
          bold = false;
        } else if (dist === 1 || dist === 2) {
          color = "white";
          bold = true;
        }

        return (
          <Text key={i} color={color} bold={bold}>
            {char}
          </Text>
        );
      })}
    </Box>
  );
}
