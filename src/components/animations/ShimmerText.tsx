import React, { useState, useEffect } from "react";
import { Text } from "ink";

export function ShimmerText({ text }: { text: string; }) {
  const [isBright, setIsBright] = useState(true);

  useEffect(() => {
    setIsBright(true);
    const timer = setTimeout(() => {
      setIsBright(false);
    }, 150); // Flash bright white for 150ms when new text arrives
    return () => clearTimeout(timer);
  }, [text]);

  return <Text color="white" bold={isBright}>{text}</Text>;
}
