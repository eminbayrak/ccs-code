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
    <Box flexDirection="column">
      {/* Header row */}
      <Box flexDirection="row">
        {(header ?? []).map((cell, c) => (
          <Text key={c} bold color="cyan">
            {" "}{padCell(cell, colWidths[c]!)}{" "}
          </Text>
        ))}
      </Box>
      {/* Separator */}
      <Box flexDirection="row">
        {(header ?? []).map((_, c) => (
          <Text key={c} dimColor>{"─".repeat((colWidths[c]! + 2))}</Text>
        ))}
      </Box>
      {/* Body rows */}
      {body.map((row, r) => (
        <Box key={r} flexDirection="row">
          {row.map((cell, c) => (
            <Box key={c} flexDirection="row">
              <Text> </Text>
              <InlineText line={padCell(cell, colWidths[c]!)} />
              <Text> </Text>
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
  | { kind: "bullet"; indent: number; text: string }
  | { kind: "numbered"; n: string; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "hr" }
  | { kind: "fence_open"; lang: string }
  | { kind: "fence_close" }
  | { kind: "table_row"; cells: string[] }
  | { kind: "table_sep" }
  | { kind: "blank" }
  | { kind: "text"; text: string };

function classifyLine(line: string): LineKind {
  if (/^```/.test(line))           return line.trim() === "```" ? { kind: "fence_close" } : { kind: "fence_open", lang: line.slice(3).trim() };
  if (/^#{3}\s/.test(line))        return { kind: "h3", text: line.slice(4) };
  if (/^#{2}\s/.test(line))        return { kind: "h2", text: line.slice(3) };
  if (/^#\s/.test(line))           return { kind: "h1", text: line.slice(2) };
  if (/^(\s*)[-*•]\s/.test(line))  {
    const m = line.match(/^(\s*)[-*•]\s(.*)/)!;
    return { kind: "bullet", indent: m[1]!.length, text: m[2]! };
  }
  if (/^\d+\.\s/.test(line)) {
    const m = line.match(/^(\d+)\.\s(.*)/)!;
    return { kind: "numbered", n: m[1]!, text: m[2]! };
  }
  if (/^>\s?/.test(line))          return { kind: "blockquote", text: line.replace(/^>\s?/, "") };
  if (/^---+$/.test(line.trim()))  return { kind: "hr" };
  if (line.trim() === "")          return { kind: "blank" };
  if (/^\|/.test(line)) {
    if (isTableSep(line)) return { kind: "table_sep" };
    return { kind: "table_row", cells: parseTableRow(line) };
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
  let key = 0;

  const flushFence = () => {
    if (fenceLines.length === 0) return;
    elements.push(
      <Box key={key++} flexDirection="column" marginBottom={1}>
        {fenceLang && (
          <Box paddingLeft={2}>
            <Text dimColor>{fenceLang}</Text>
          </Box>
        )}
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          paddingLeft={1}
        >
          {fenceLines.map((l, i) => (
            <Box key={i}>
              <HighlightedLine line={l || " "} lang={fenceLang} />
            </Box>
          ))}
        </Box>
      </Box>
    );
    fenceLines = [];
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const k = key++;
    elements.push(
      <Box key={k} flexDirection="column" paddingLeft={1} marginBottom={1}>
        {renderTable(tableRows, k)}
      </Box>
    );
    tableRows = [];
  };

  for (const raw of rawLines) {
    if (inFence) {
      if (raw.trimEnd() === "```") {
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

    switch (cl.kind) {
      case "fence_open":
        inFence = true;
        fenceLang = cl.lang;
        break;

      case "h1":
        elements.push(
          <Box key={key++} flexDirection="column" marginTop={1}>
            <Text bold color="green">{cl.text}</Text>
            <Text dimColor>{"─".repeat(Math.min(cl.text.length + 2, w - 4))}</Text>
          </Box>
        );
        break;

      case "h2":
        elements.push(
          <Box key={key++} marginTop={1}>
            <Text bold color="cyan">{cl.text}</Text>
          </Box>
        );
        break;

      case "h3":
        elements.push(
          <Box key={key++} marginTop={1}>
            <Text bold color="white">{cl.text}</Text>
          </Box>
        );
        break;

      case "bullet":
        elements.push(
          <Box key={key++} flexDirection="row" paddingLeft={cl.indent > 0 ? cl.indent + 2 : 2}>
            <Text color="green">{"› "}</Text>
            <InlineText line={cl.text} />
          </Box>
        );
        break;

      case "numbered":
        elements.push(
          <Box key={key++} flexDirection="row" paddingLeft={2}>
            <Text color="cyan" dimColor>{`${cl.n}. `}</Text>
            <InlineText line={cl.text} />
          </Box>
        );
        break;

      case "blockquote":
        elements.push(
          <Box key={key++} flexDirection="row" paddingLeft={1}>
            <Text color="yellow">{"▎ "}</Text>
            <InlineText line={cl.text} />
          </Box>
        );
        break;

      case "hr":
        elements.push(
          <Box key={key++} marginY={0}>
            <Text dimColor>{"─".repeat(Math.min(w - 4, 72))}</Text>
          </Box>
        );
        break;

      case "blank":
        elements.push(<Box key={key++}><Text>{" "}</Text></Box>);
        break;

      case "text":
        elements.push(
          <Box key={key++}>
            <InlineText line={cl.text} />
          </Box>
        );
        break;
    }
  }

  if (inFence && fenceLines.length > 0) flushFence();
  if (tableRows.length > 0) flushTable();

  return <Box flexDirection="column">{elements}</Box>;
}
