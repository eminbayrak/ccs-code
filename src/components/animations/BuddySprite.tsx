import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

const BODIES = {
  cat: [
    "   /\\_/\\    \n  ( {E}   {E})  \n  (  ω  )   \n  (\")_(\")   ",
    "   /\\_/\\    \n  ( {E}   {E})  \n  (  ω  )   \n  (\")_(\")~  ",
    "   /\\-/\\    \n  ( {E}   {E})  \n  (  ω  )   \n  (\")_(\")   ",
  ],
  duck: [
    "    __      \n  <({E} )___  \n   (  ._>   \n    `--´    ",
    "    __      \n  <({E} )___  \n   (  ._>   \n    `--´~   ",
    "    __      \n  <({E} )___  \n   (  .__>  \n    `--´    ",
  ],
  blob: [
    "   .----.   \n  ( {E}  {E} )  \n  (      )  \n   `----´   ",
    "  .------.  \n (  {E}  {E}  ) \n (        ) \n  `------´  ",
    "    .--.    \n   ({E}  {E})   \n   (    )   \n    `--´    ",
  ]
};

export type Species = keyof typeof BODIES;

type Props = {
  species?: Species;
  isProcessing?: boolean;
};

export function BuddySprite({ species = "cat", isProcessing = false }: Props) {
  const [frameIdx, setFrameIdx] = useState(0);

  useEffect(() => {
    // Fidget timer mapping just like Claude Code
    const timer = setInterval(() => {
      setFrameIdx((i) => (i + 1) % BODIES[species].length);
    }, isProcessing ? 200 : 700);

    return () => clearInterval(timer);
  }, [species, isProcessing]);

  const frameStr = BODIES[species]?.[frameIdx] ?? BODIES["cat"][0] ?? "";
  // Replace {E} with eyes based on processing state
  const eye = isProcessing ? "^" : "o";
  const processedStr = frameStr.replace(/\{E\}/g, eye);

  return (
    <Box flexDirection="column" marginRight={2}>
      {processedStr.split('\n').map((line, i) => (
        <Text key={i} color="magenta" bold={isProcessing}>{line}</Text>
      ))}
    </Box>
  );
}
