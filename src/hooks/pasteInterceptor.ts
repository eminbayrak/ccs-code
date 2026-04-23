/**
 * Paste interceptor — patches process.stdin.read(), which is the exact method
 * Ink calls inside its 'readable' event handler to get chunks from stdin.
 *
 * Root cause of every previous failure:
 *   Ink does NOT use the 'data' event. It uses:
 *     stdin.addListener('readable', handleReadable)
 *   and inside handleReadable:
 *     while ((chunk = stdin.read()) !== null) { ... }
 *
 *   Patching addListener('data', ...) or emit('data', ...) never intercepted
 *   anything — Ink never used those paths. By patching stdin.read() itself,
 *   we sit exactly where Ink reads, and can strip paste sequences before they
 *   ever reach Ink's input parser.
 *
 * Flow:
 *   1. User pastes → terminal sends \x1b[200~text\x1b[201~
 *   2. stdin becomes readable → Ink calls stdin.read()
 *   3. Our patched read() strips the escape sequences, calls _handler("text")
 *   4. We return null (or non-paste bytes) to Ink — Ink sees no escape chars
 *   5. _handler → setInput(prev => prev + "text") → React re-render ✓
 */

const PASTE_START = "\x1b[200~";
const PASTE_END   = "\x1b[201~";

type Handler = (text: string) => void;

let _handler: Handler | null  = null;
let _isPasting               = false;
let _buffer                  = "";
let _installed               = false;

function filterChunk(raw: string): string {
  if (!_isPasting && !raw.includes(PASTE_START)) return raw;

  let pos = 0;
  let out = "";

  while (pos < raw.length) {
    if (!_isPasting) {
      const si = raw.indexOf(PASTE_START, pos);
      if (si === -1) { out += raw.slice(pos); break; }
      if (si > pos) out += raw.slice(pos, si); // bytes before paste start
      _isPasting = true;
      _buffer    = "";
      pos = si + PASTE_START.length;
    } else {
      const ei = raw.indexOf(PASTE_END, pos);
      if (ei === -1) { _buffer += raw.slice(pos); break; } // still buffering
      _buffer   += raw.slice(pos, ei);
      _isPasting = false;
      const clean = _buffer.replace(/\r\n?/g, " ").replace(/\n/g, " ").trim();
      _buffer = "";
      pos = ei + PASTE_END.length;
      if (clean) _handler?.(clean);
      // bytes after paste end continue in next iteration
    }
  }

  return out; // everything that wasn't inside a paste sequence
}

export function installPasteInterceptor(): void {
  if (_installed) return;
  _installed = true;

  // Enable bracketed paste — terminal wraps Cmd+V in \x1b[200~...\x1b[201~
  process.stdout.write("\x1b[?2004h");

  // Patch stdin.read() — this is what Ink calls inside its readable handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stdin    = process.stdin as any;
  const origRead = stdin.read.bind(stdin);

  stdin.read = function (...args: unknown[]) {
    const chunk = origRead(...args);
    if (chunk === null) return null;

    const raw      = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const filtered = filterChunk(raw);

    if (filtered === raw) return chunk;          // no paste — unchanged
    if (!filtered)        return null;           // all paste — tell Ink stream is empty
    return Buffer.from(filtered, "utf8");        // mixed — return only non-paste bytes
  };

  process.on("exit", () => {
    process.stdout.write("\x1b[?2004l");
    stdin.read = origRead; // restore
  });
}

export function setPasteHandler(handler: Handler | null): void {
  _handler = handler;
}
