import { useEffect, useRef } from "react";
import { setPasteHandler } from "./pasteInterceptor.js";

/**
 * Register a paste handler with the module-level paste interceptor.
 * The interceptor itself is installed in main.tsx BEFORE render(), which
 * ensures it wraps Ink's stdin listeners before they're registered.
 *
 * Returns a ref that is always false (kept for API compatibility so the
 * useInput guard in App.tsx doesn't need to change).
 */
export function usePaste(
  onPaste: (text: string) => void,
  disabled = false,
): React.MutableRefObject<boolean> {
  const isPastingRef = useRef(false);
  const onPasteRef   = useRef(onPaste);
  useEffect(() => { onPasteRef.current = onPaste; });

  useEffect(() => {
    if (disabled) {
      setPasteHandler(null);
      return;
    }
    setPasteHandler((text) => onPasteRef.current(text));
    return () => setPasteHandler(null);
  }, [disabled]);

  return isPastingRef;
}
