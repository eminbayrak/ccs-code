import React from "react";
import { Box, Text } from "ink";

// ── Inline span types ─────────────────────────────────────────────────────────

type Span =
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; url: string }
  | { type: "plain"; text: string };

function parseInline(line: string): Span[] {
  const spans: Span[] = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line)) !== null) {
    if (m.index > last) spans.push({ type: "plain", text: line.slice(last, m.index) });
    if (m[0].startsWith("**"))    spans.push({ type: "bold",   text: m[2]! });
    else if (m[0].startsWith("*")) spans.push({ type: "italic", text: m[3]! });
    else if (m[0].startsWith("`")) spans.push({ type: "code",   text: m[4]! });
    else                           spans.push({ type: "link",   text: m[5]!, url: m[6]! });
    last = m.index + m[0].length;
  }

  if (last < line.length) spans.push({ type: "plain", text: line.slice(last) });
  return spans;
}

function InlineText({ line }: { line: string }) {
  const spans = parseInline(line);
  return (
    <>
      {spans.map((s, i) => {
        switch (s.type) {
          case "bold":   return <Text key={i} bold color="white">{s.text}</Text>;
          case "italic": return <Text key={i} italic>{s.text}</Text>;
          case "code":   return <Text key={i} color="yellow">{"`"}{s.text}{"`"}</Text>;
          case "link":   return <Text key={i} color="cyan" underline>{s.text}</Text>;
          default:       return <Text key={i}>{s.text}</Text>;
        }
      })}
    </>
  );
}

// ── Syntax highlighting ───────────────────────────────────────────────────────

function HighlightedLine({ line, lang }: { line: string; lang: string }) {
  const l = lang.toLowerCase();

  if (l === "bash" || l === "sh" || l === "shell" || l === "zsh") {
    if (line.trim().startsWith("#")) return <Text dimColor>{line}</Text>;
    const m = line.match(/^(\s*)([\w./\-]+)(.*)/);
    if (m) {
      return (
        <>
          <Text>{m[1]}</Text>
          <Text color="green">{m[2]}</Text>
          <Text color="white">{m[3]}</Text>
        </>
      );
    }
    return <Text color="green">{line}</Text>;
  }

  if (l === "yaml" || l === "yml") {
    if (line.trim().startsWith("#")) return <Text dimColor>{line}</Text>;
    const m = line.match(/^(\s*)([\w-]+)(\s*:.*)$/);
    if (m) {
      return (
        <>
          <Text>{m[1]}</Text>
          <Text color="cyan">{m[2]}</Text>
          <Text color="white">{m[3]}</Text>
        </>
      );
    }
    return <Text color="white">{line}</Text>;
  }

  if (l === "json") {
    const m = line.match(/^(\s*)("[\w-]+")\s*:/);
    if (m) {
      return (
        <>
          <Text>{m[1]}</Text>
          <Text color="cyan">{m[2]}</Text>
          <Text color="white">{line.slice(m[0].length)}</Text>
        </>
      );
    }
    return <Text color="white">{line}</Text>;
  }

  if (l === "ts" || l === "tsx" || l === "js" || l === "jsx") {
    if (line.trim().startsWith("//")) return <Text dimColor>{line}</Text>;
    const keywords = /\b(import|export|const|let|var|function|return|if|else|for|while|class|type|interface|async|await|from|default)\b/;
    if (keywords.test(line)) return <Text color="magenta">{line}</Text>;
    return <Text color="white">{line}</Text>;
  }

  // Default: green (looks like terminal output)
  return <Text color="green">{line}</Text>;
}

// ── Table parsing & rendering ─────────────────────────────────────────────────

function parseTableRow(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

function isTableSep(line: string): boolean {
  return /^\|[\s|:\-]+\|$/.test(line.trim());
}

function renderTable(rows: string[][], startKey: number): React.ReactNode {
  if (rows.length === 0) return null;

  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = Array(colCount).fill(0) as number[];

  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const w = (row[c] ?? "").replace(/`[^`]+`/g, (m) => m.slice(1, -1)).length;
      colWidths[c] = Math.max(colWidths[c]!, w);
    }
  }

  const [header, ...body] = rows;

  function padCell(cell: string, width: number) {
    // Strip inline code markers for padding calculation
    const raw = cell.replace(/`[^`]+`/g, (m) => m.slice(1, -1));
    const pad = Math.max(0, width - raw.length);
    return cell + " ".repeat(pad);
  }

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Header row */}
      <Box flexDirection="row" backgroundColor="blue" paddingX={1}>
        {(header ?? []).map((cell, c) => (
          <Text key={c} bold color="white">
            {padCell(cell, colWidths[c]!)} {"  "}
          </Text>
        ))}
      </Box>
      {/* Body rows */}
      {body.map((row, r) => (
        <Box key={r} flexDirection="row" paddingX={1}>
          {row.map((cell, c) => (
            <Box key={c} flexDirection="row">
              <InlineText line={padCell(cell, colWidths[c]!)} />
              <Text> {"  "}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ── Line classification ───────────────────────────────────────────────────────

type LineKind =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "h4"; text: string }
  | { kind: "h5"; text: string }
  | { kind: "bullet"; indent: number; text: string }
  | { kind: "numbered"; n: string; text: string }
  | { kind: "alert"; type: "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION"; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "hr" }
  | { kind: "fence_open"; lang: string }
  | { kind: "fence_close" }
  | { kind: "table_row"; cells: string[] }
  | { kind: "table_sep" }
  | { kind: "blank" }
  | { kind: "text"; text: string };

function classifyLine(line: string): LineKind {
  const trimmed = line.trim();
  if (trimmed.startsWith("```")) return trimmed === "```" ? { kind: "fence_close" } : { kind: "fence_open", lang: trimmed.slice(3).trim() };
  if (/^#{5}\s/.test(trimmed))   return { kind: "h5", text: trimmed.slice(6) };
  if (/^#{4}\s/.test(trimmed))   return { kind: "h4", text: trimmed.slice(5) };
  if (/^#{3}\s/.test(trimmed))   return { kind: "h3", text: trimmed.slice(4) };
  if (/^#{2}\s/.test(trimmed))   return { kind: "h2", text: trimmed.slice(3) };
  if (/^#\s/.test(trimmed))      return { kind: "h1", text: trimmed.slice(2) };
  
  if (/^>\s?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/.test(trimmed)) {
    const m = trimmed.match(/^>\s?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](.*)/)!;
    return { kind: "alert", type: m[1] as any, text: m[2]!.trim() };
  }
  if (/^>\s?/.test(trimmed))      return { kind: "blockquote", text: trimmed.replace(/^>\s?/, "") };
  
  if (/^(\s*)[-*•]\s/.test(line))  {
    const m = line.match(/^(\s*)[-*•]\s(.*)/)!;
    return { kind: "bullet", indent: m[1]!.length, text: m[2]! };
  }
  if (/^\d+\.\s/.test(trimmed)) {
    const m = trimmed.match(/^(\d+)\.\s(.*)/)!;
    return { kind: "numbered", n: m[1]!, text: m[2]! };
  }
  if (/^---+$/.test(trimmed))  return { kind: "hr" };
  if (trimmed === "")          return { kind: "blank" };
  if (/^\|/.test(trimmed)) {
    if (isTableSep(trimmed)) return { kind: "table_sep" };
    return { kind: "table_row", cells: parseTableRow(trimmed) };
  }
  return { kind: "text", text: line };
}

// ── Main component ────────────────────────────────────────────────────────────

export function MarkdownText({ content, width }: { content: string; width?: number }) {
  const rawLines = content.split("\n");
  const elements: React.ReactNode[] = [];
  const w = width ?? 80;

  let inFence = false;
  let fenceLang = "";
  let fenceLines: string[] = [];
  let tableRows: string[][] = [];
  let blockquoteLines: string[] = [];
  let activeAlert: { type: string; lines: string[] } | null = null;
  let key = 0;

  const flushFence = () => {
    if (fenceLines.length === 0) return;
    const lang = fenceLang || "";
    elements.push(
      <Box key={key++} flexDirection="column" marginTop={1} marginBottom={1} width={w}>
        {/* ── header bar: lang badge + top rule ── */}
        <Box flexDirection="row" paddingLeft={1} gap={1}>
          <Text color="gray">{"╭"}</Text>
          {lang && <Text color="blueBright" dimColor>{` ${lang} `}</Text>}
          <Text color="gray">{"─".repeat(Math.max(0, w - (lang ? lang.length + 5 : 4)))}</Text>
          <Text color="gray">{"╮"}</Text>
        </Box>
        {/* ── code lines ── */}
        {fenceLines.map((l, i) => (
          <Box key={i} flexDirection="row" width={w}>
            <Text color="gray">{"│"}</Text>
            <Box width={w - 4} paddingLeft={1}>
              <HighlightedLine line={l || " "} lang={lang} />
            </Box>
            <Text color="gray">{"│"}</Text>
          </Box>
        ))}
        {/* ── bottom border ── */}
        <Box flexDirection="row" paddingLeft={1}>
          <Text color="gray">{"╰"}</Text>
          <Text color="gray">{"─".repeat(Math.max(0, w - 4))}</Text>
          <Text color="gray">{"╯"}</Text>
        </Box>
      </Box>
    );
    fenceLines = [];
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const k = key++;
    elements.push(
      <Box key={k} flexDirection="column" paddingLeft={1} marginBottom={1} width={w}>
        {renderTable(tableRows, k)}
      </Box>
    );
    tableRows = [];
  };

  const flushBlockquote = () => {
    if (blockquoteLines.length === 0) return;
    elements.push(
      <Box key={key++} flexDirection="column" paddingLeft={1} marginBottom={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="yellow" width={w}>
        {blockquoteLines.map((l, i) => (
          <Box key={i} width={w - 2}><InlineText line={l} /></Box>
        ))}
      </Box>
    );
    blockquoteLines = [];
  };

  const flushAlert = () => {
    if (!activeAlert) return;
    const colorMap: Record<string, string> = {
      NOTE: "blue",
      TIP: "green",
      IMPORTANT: "magenta",
      WARNING: "yellow",
      CAUTION: "red",
    };
    const color = colorMap[activeAlert.type] || "white";
    const icon = activeAlert.type === "WARNING" || activeAlert.type === "CAUTION" ? "⚠" : "ℹ";

    elements.push(
      <Box key={key++} flexDirection="column" paddingX={1} marginY={1} borderStyle="round" borderColor={color} width={w}>
        <Box marginBottom={1} flexDirection="row" gap={1}>
          <Text bold color={color}>{icon} {activeAlert.type}</Text>
        </Box>
        {activeAlert.lines.map((l, i) => (
          <Box key={i} width={w - 4} flexWrap="wrap"><InlineText line={l} /></Box>
        ))}
      </Box>
    );
    activeAlert = null;
  };

  for (const raw of rawLines) {
    if (inFence) {
      if (raw.trim() === "```") {
        flushFence();
        inFence = false;
      } else {
        fenceLines.push(raw);
      }
      continue;
    }

    const cl = classifyLine(raw);

    if (cl.kind === "table_row") { tableRows.push(cl.cells); continue; }
    if (cl.kind === "table_sep") { continue; }
    if (tableRows.length > 0) flushTable();

    if (cl.kind === "blockquote") {
      if (activeAlert) { activeAlert.lines.push(cl.text); continue; }
      blockquoteLines.push(cl.text); 
      continue; 
    }
    if (blockquoteLines.length > 0) flushBlockquote();

    if (cl.kind === "alert") {
      if (activeAlert) flushAlert();
      activeAlert = { type: cl.type, lines: cl.text ? [cl.text] : [] };
      continue;
    }
    // If it's a blank line and we are in an alert, it might just be a spacer
    if (cl.kind === "blank" && activeAlert) {
      activeAlert.lines.push("");
      continue;
    }
    if (activeAlert) {
      flushAlert();
    }

    switch (cl.kind) {
      case "fence_open":
        inFence = true;
        fenceLang = cl.lang;
        break;

      case "h1":
        elements.push(
          <Box key={key++} flexDirection="column" marginTop={1} marginBottom={0} width={w}>
            <Text bold color="white">{cl.text.toUpperCase()}</Text>
          </Box>
        );
        break;

      case "h2":
        elements.push(
          <Box key={key++} marginTop={1} width={w}>
            <Text bold color="#fcd34d">{cl.text}</Text>
          </Box>
        );
        break;

      case "h3":
        elements.push(
          <Box key={key++} marginTop={1} width={w}>
            <Text bold color="white">{cl.text}</Text>
          </Box>
        );
        break;

      case "h4":
        elements.push(
          <Box key={key++} marginTop={1} width={w}>
            <Text bold color="#9ca3af">{cl.text}</Text>
          </Box>
        );
        break;

      case "h5":
        elements.push(
          <Box key={key++} marginTop={1} width={w}>
            <Text bold italic color="#d1d5db">{cl.text}</Text>
          </Box>
        );
        break;

      case "bullet":
        elements.push(
          <Box key={key++} flexDirection="row" paddingLeft={cl.indent + 1} width={w}>
            <Text color="#9ca3af">{"• "}</Text>
            <Box flexShrink={1} flexGrow={0}><InlineText line={cl.text} /></Box>
          </Box>
        );
        break;

      case "numbered":
        elements.push(
          <Box key={key++} flexDirection="row" paddingLeft={1} width={w}>
            <Text color="#9ca3af" dimColor>{`${cl.n}. `}</Text>
            <Box width={w - 6}><InlineText line={cl.text} /></Box>
          </Box>
        );
        break;

      case "hr":
        elements.push(
          <Box key={key++} marginY={1} width={w}>
            <Text dimColor>{"─".repeat(Math.min(w - 4, 72))}</Text>
          </Box>
        );
        break;

      case "blank":
        elements.push(<Box key={key++} height={1} />);
        break;

      case "text": {
        // ── error/warn/success prefix colouring ──────────────────────────────
        const trimmed = cl.text.trim();
        const isSuccess  = trimmed.startsWith("✓") || trimmed.startsWith("✅");
        const isWarn     = trimmed.startsWith("⚠") || trimmed.startsWith("⚠️");
        const isFail     = trimmed.startsWith("✗");
        const isRateErr  = trimmed.startsWith("[Gemini]") || trimmed.startsWith("[Anthropic]") || trimmed.startsWith("[OpenAI]");
        // Indent the rate-error continuation lines (quota/retry lines)
        const isErrDetail = trimmed.startsWith("Quota:") || trimmed.startsWith("Retry in:");

        let textColor: string | undefined;
        if (isSuccess)        textColor = "green";
        else if (isWarn)      textColor = "yellow";
        else if (isFail || isRateErr) textColor = "red";
        else if (isErrDetail) textColor = "yellow";

        elements.push(
          <Box key={key++} width={w} flexWrap="wrap" marginBottom={0}
            paddingLeft={isErrDetail ? 2 : 0}
          >
            {textColor ? (
              <Text color={textColor as any} bold={isFail || isRateErr}>
                <InlineText line={cl.text} />
              </Text>
            ) : (
              <InlineText line={cl.text} />
            )}
          </Box>
        );
        break;
      }
    }
  }

  if (inFence && fenceLines.length > 0) flushFence();
  if (tableRows.length > 0) flushTable();
  if (blockquoteLines.length > 0) flushBlockquote();
  if (activeAlert) flushAlert();

  return <Box flexDirection="column" width={w}>{elements}</Box>;
}

