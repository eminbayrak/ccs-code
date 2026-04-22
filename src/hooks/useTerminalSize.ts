import { useState, useEffect } from "react";
import { useStdout } from "ink";

export type TerminalSize = {
  columns: number;
  rows: number;
};

/**
 * Reactively tracks terminal dimensions.
 * Re-renders any component using this hook whenever the terminal is resized —
 * the same pattern used by Claude Code's useTerminalSize hook.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const [size, setSize] = useState<TerminalSize>({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;

    function onResize() {
      setSize({
        columns: stdout!.columns ?? 80,
        rows: stdout!.rows ?? 24,
      });
    }

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
