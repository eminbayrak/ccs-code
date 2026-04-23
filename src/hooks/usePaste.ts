import { useEffect, useRef } from "react";

/**
 * Disables bracketed paste mode so pasted text arrives as plain keystrokes.
 *
 * Without this, modern terminals wrap paste in \x1b[200~...\x1b[201~.
 * Ink interprets the leading \x1b as an escape key press, and the trailing
 * [201~ lands as literal text in the input — breaking paste entirely.
 *
 * Disabling bracketed paste mode makes paste indistinguishable from typing,
 * which ink-text-input handles correctly via its normal onChange path.
 *
 * Returns a ref that is always false (kept for API compatibility so callers
 * don't need to change their useInput guards).
 */
export function usePaste(
  _onPaste: (text: string) => void,
  disabled = false,
): React.MutableRefObject<boolean> {
  const isPastingRef = useRef(false);

  useEffect(() => {
    if (disabled) return;
    process.stdout.write("\x1b[?2004l");
  }, [disabled]);

  return isPastingRef;
}
