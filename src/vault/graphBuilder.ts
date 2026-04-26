import { promises as fs } from "fs";
import { dirname, join, basename, extname } from "path";

type Node = { id: string; label: string; group: string; title: string; keywords: string[]; path: string };
type Edge = { from: string; to: string; label?: string };

// Topic clusters — keyword → group name
const TOPIC_MAP: Array<[RegExp, string]> = [
  [/\b(code|coding|program|typescript|javascript|python|react|node|api|function|bug|debug|script|bun|sql|database|query)\b/i, "code"],
  [/\b(design|ui|ux|figma|component|layout|style|css|tailwind|frontend|visual)\b/i, "design"],
  [/\b(write|writing|essay|blog|article|content|draft|edit|document|readme|docs)\b/i, "writing"],
  [/\b(data|analysis|analytics|chart|graph|excel|csv|json|parse|extract|pipeline)\b/i, "data"],
  [/\b(ai|llm|gpt|claude|prompt|model|agent|machine learning|neural|embedding)\b/i, "ai"],
  [/\b(plan|strategy|roadmap|project|goal|task|todo|workflow|process|system)\b/i, "planning"],
  [/\b(linux|mac|terminal|shell|bash|git|docker|deploy|server|cloud|aws|devops)\b/i, "devops"],
  [/\b(learn|study|explain|understand|how|what|why|concept|tutorial|guide)\b/i, "learning"],
];

// Obsidian-style vivid jewel tone colors
const GROUP_COLORS: Record<string, { fill: string; glow: string }> = {
  code:         { fill: "#7c5cfc", glow: "#7c5cfc" },   // vivid purple
  design:       { fill: "#ff6b9d", glow: "#ff6b9d" },   // hot pink
  writing:      { fill: "#4ecdc4", glow: "#4ecdc4" },   // teal
  data:         { fill: "#ffd93d", glow: "#ffd93d" },   // bright yellow
  ai:           { fill: "#6bcb77", glow: "#6bcb77" },   // vivid green
  planning:     { fill: "#ff9a3c", glow: "#ff9a3c" },   // orange
  devops:       { fill: "#4d96ff", glow: "#4d96ff" },   // electric blue
  learning:     { fill: "#ff6b6b", glow: "#ff6b6b" },   // coral red
  concept:      { fill: "#c77dff", glow: "#c77dff" },   // violet
  conversation: { fill: "#48cae4", glow: "#48cae4" },   // cyan
  memory:       { fill: "#4d96ff", glow: "#4d96ff" },   // electric blue
  unknown:      { fill: "#8892a4", glow: "#8892a4" },   // neutral
};

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with",
  "by","from","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","can",
  "not","no","nor","so","yet","both","either","neither","each","few","more",
  "most","other","some","such","than","that","this","these","those","how",
  "what","when","where","who","which","why","your","my","his","her","its",
  "our","their","about","after","before","between","into","through","during",
  "i","you","he","she","it","we","they","them","him","us","me",
]);

function detectGroup(text: string): string {
  for (const [re, group] of TOPIC_MAP) {
    if (re.test(text)) return group;
  }
  return "unknown";
}

function extractKeywords(text: string): string[] {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

function parseMeta(raw: string): { type: string; title: string; summary: string; tags: string[] } {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  let type = "unknown", title = "", summary = "";
  let tags: string[] = [];
  if (fmMatch) {
    const fm = fmMatch[1] ?? "";
    const typeM    = fm.match(/^type:\s*(.+)$/m);
    const titleM   = fm.match(/^title:\s*(.+)$/m);
    const summaryM = fm.match(/^summary:\s*(.+)$/m);
    const tagsM    = fm.match(/^tags:\s*\[(.+)\]/m);
    if (typeM?.[1])    type    = typeM[1].trim();
    if (titleM?.[1])   title   = titleM[1].trim().replace(/^"|"$/g, "");
    if (summaryM?.[1]) summary = summaryM[1].trim();
    if (tagsM?.[1])    tags    = tagsM[1].split(",").map(t => t.trim().replace(/"/g, ""));
  }
  return { type, title, summary, tags };
}

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.name.endsWith(".md")) out.push(join(d, e.name));
    }
  }
  await walk(dir);
  return out;
}

export async function buildGraphData(wikiDir: string): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const files = await walkMd(wikiDir);
  const nodes: Node[] = [];

  for (const fpath of files) {
    const raw = await fs.readFile(fpath, "utf-8");
    const id = basename(fpath, ".md").toLowerCase().replace(/\s+/g, "-");
    const { type, title, summary, tags } = parseMeta(raw);

    const body = raw.replace(/^---[\s\S]*?---\n/, "").slice(0, 1000);
    const fullText = `${title} ${summary} ${body} ${tags.join(" ")}`;

    const group = type !== "unknown" ? type : detectGroup(fullText);
    // Deep scan: Extract keywords from body as well to ensure orphan memories get linked
    const keywords = extractKeywords(`${title} ${summary} ${body} ${tags.join(" ")}`);
    const label = title || basename(fpath, extname(fpath));

    nodes.push({ id, label, group, title: summary || label, keywords, path: fpath });
  }

  const keywordIndex = new Map<string, string[]>();
  for (const node of nodes) {
    for (const kw of node.keywords) {
      const list = keywordIndex.get(kw) ?? [];
      list.push(node.id);
      keywordIndex.set(kw, list);
    }
  }

  const edgeSet = new Set<string>();
  const edges: Edge[] = [];
  const connectionCount = new Map<string, number>();

  const sortedKeywords = [...keywordIndex.entries()]
    .filter(([, ids]) => ids.length >= 2 && ids.length <= 30)
    .sort(([, a], [, b]) => a.length - b.length);

  for (const [keyword, nodeIds] of sortedKeywords) {
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const a = nodeIds[i]!;
        const b = nodeIds[j]!;
        const key = a < b ? `${a}__${b}` : `${b}__${a}`;
        if (edgeSet.has(key)) continue;

        const ca = connectionCount.get(a) ?? 0;
        const cb = connectionCount.get(b) ?? 0;
        if (ca >= 12 || cb >= 12) continue;

        edgeSet.add(key);
        edges.push({ from: a, to: b, label: keyword });
        connectionCount.set(a, ca + 1);
        connectionCount.set(b, cb + 1);
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Generate self-contained HTML — Obsidian-style graph
// ---------------------------------------------------------------------------

export async function generateGraphHtml(wikiDir: string, outputPath: string): Promise<{ nodeCount: number; edgeCount: number }> {
  const { nodes, edges } = await buildGraphData(wikiDir);

  // Serialize color map for JS
  const colorMapJs = Object.entries(GROUP_COLORS)
    .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
    .join(",\n    ");

  // Connection count per node for sizing
  const connCount: Record<string, number> = {};
  for (const e of edges) {
    connCount[e.from] = (connCount[e.from] ?? 0) + 1;
    connCount[e.to]   = (connCount[e.to]   ?? 0) + 1;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CCS Code — Knowledge Graph</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    background: #0a0a0f;
    color: #e2e8f0;
    font-family: -apple-system, 'Segoe UI', sans-serif;
  }
  #graph { width: 100vw; height: 100vh; }

  /* ── Search bar ── */
  #search-wrap {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    z-index: 20;
  }
  #search {
    background: rgba(15,15,25,0.92);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 24px;
    padding: 8px 18px;
    color: #e2e8f0;
    font-size: 13px;
    width: 260px;
    outline: none;
    backdrop-filter: blur(12px);
    font-family: inherit;
  }
  #search::placeholder { color: rgba(255,255,255,0.3); }
  #search:focus { border-color: rgba(255,255,255,0.28); }

  /* ── Legend ── */
  #legend {
    position: fixed; top: 16px; left: 16px; z-index: 20;
    background: rgba(10,10,20,0.82);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    padding: 12px 14px;
    backdrop-filter: blur(12px);
  }
  #legend-title {
    font-size: 10px; letter-spacing: 2px; color: rgba(255,255,255,0.3);
    text-transform: uppercase; margin-bottom: 8px;
  }
  .leg { display: flex; align-items: center; gap: 8px; margin: 5px 0; cursor: pointer; }
  .leg-dot {
    width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
    box-shadow: 0 0 6px var(--glow);
  }
  .leg-label { font-size: 12px; color: rgba(255,255,255,0.55); transition: color 0.15s; }
  .leg:hover .leg-label { color: rgba(255,255,255,0.9); }

  /* ── Stats ── */
  #stats {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: rgba(10,10,20,0.72);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 20px;
    padding: 5px 16px;
    font-size: 11px;
    color: rgba(255,255,255,0.3);
    letter-spacing: 1px;
    backdrop-filter: blur(8px);
  }

  /* ── Info panel ── */
  #info {
    position: fixed; top: 16px; right: 16px; z-index: 20;
    background: rgba(10,10,20,0.92);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 16px 18px;
    max-width: 260px;
    display: none;
    backdrop-filter: blur(16px);
  }
  #info-group-dot {
    width: 10px; height: 10px; border-radius: 50%;
    display: inline-block; margin-right: 8px; flex-shrink: 0;
  }
  #info-header { display: flex; align-items: center; margin-bottom: 10px; }
  #info-title { font-size: 14px; font-weight: 600; color: #f1f5f9; line-height: 1.3; }
  #info-body { font-size: 12px; color: rgba(255,255,255,0.45); line-height: 1.6; margin-bottom: 10px; }
  #info-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .itag {
    font-size: 10px; border-radius: 4px;
    padding: 2px 7px; border: 1px solid;
    opacity: 0.75;
  }
  #info-connections {
    margin-top: 10px;
    font-size: 11px; color: rgba(255,255,255,0.25);
    padding: 10px 0; border-top: 1px solid rgba(255,255,255,0.06);
  }
  #info-actions {
    margin-top: 8px;
    display: flex;
    gap: 8px;
  }
  .action-btn {
    flex: 1;
    text-align: center;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #f1f5f9;
    padding: 6px;
    font-size: 11px;
    text-decoration: none;
    transition: all 0.2s;
  }
  .action-btn:hover {
    background: rgba(255,255,255,0.1);
    border-color: rgba(255,255,255,0.2);
  }
  .action-btn.primary {
    background: rgba(124, 92, 252, 0.2);
    border-color: rgba(124, 92, 252, 0.4);
    color: #a78bfa;
  }
  .action-btn.primary:hover {
    background: rgba(124, 92, 252, 0.3);
    border-color: rgba(124, 92, 252, 0.6);
  }

  /* ── Controls hint ── */
  #hint {
    position: fixed; bottom: 16px; right: 16px;
    font-size: 11px; color: rgba(255,255,255,0.18);
    line-height: 1.8; text-align: right;
  }
</style>
</head>
<body>

<div id="graph"></div>

<div id="search-wrap">
  <input id="search" type="text" placeholder="Search nodes…" />
</div>

<div id="legend">
  <div id="legend-title">Groups</div>
  ${Object.entries(GROUP_COLORS).map(([k, v]) => `
  <div class="leg" data-group="${k}" onclick="filterGroup('${k}')">
    <div class="leg-dot" style="background:${v.fill};--glow:${v.glow}"></div>
    <span class="leg-label">${k}</span>
  </div>`).join("")}
</div>

<div id="stats">${nodes.length} nodes &nbsp;·&nbsp; ${edges.length} edges</div>

<div id="info">
  <div id="info-header">
    <span id="info-group-dot"></span>
    <span id="info-title"></span>
  </div>
  <div id="info-body"></div>
  <div id="info-tags"></div>
  <div id="info-connections"></div>
  <div id="info-actions">
    <a id="open-btn" class="action-btn primary" href="#">Open in Editor</a>
  </div>
</div>

<div id="hint">
  scroll to zoom<br>
  drag to pan<br>
  click node for info
</div>

<script>
const COLORS = {
  ${colorMapJs}
};

const rawNodes = ${JSON.stringify(nodes)};
const rawEdges = ${JSON.stringify(edges)};
const connCount = ${JSON.stringify(connCount)};

function getColor(group) {
  return COLORS[group] ?? COLORS["unknown"];
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return \`rgba(\${r},\${g},\${b},\${alpha})\`;
}

const nodesDs = new vis.DataSet(rawNodes.map(n => {
  const c = getColor(n.group);
  const conn = connCount[n.id] ?? 0;
  const size = 7 + Math.min(22, conn * 2.5);
  return {
    id: n.id,
    label: n.label.length > 22 ? n.label.slice(0, 20) + "…" : n.label,
    fullLabel: n.label,
    title: undefined,
    group: n.group,
    keywords: n.keywords,
    summary: n.title,
    connections: conn,
    color: {
      background: c.fill,
      border: hexToRgba(c.fill, 0.4),
      highlight: { background: "#ffffff", border: c.fill },
      hover:      { background: "#ffffff", border: c.fill },
    },
    shadow: {
      enabled: true,
      color: hexToRgba(c.glow, 0.55),
      x: 0, y: 0, size: size + 6,
    },
    font: {
      color: "rgba(255,255,255,0.72)",
      size: 11,
      face: "-apple-system, 'Segoe UI', sans-serif",
      strokeWidth: 3,
      strokeColor: "rgba(0,0,0,0.7)",
    },
    shape: "dot",
    size,
  };
}));

const edgesDs = new vis.DataSet(rawEdges.map(e => ({
  from: e.from,
  to: e.to,
  keyword: e.label,
  color: { color: "rgba(255,255,255,0.06)", highlight: "rgba(255,255,255,0.5)", hover: "rgba(255,255,255,0.35)" },
  width: 1,
  hoverWidth: 2,
  selectionWidth: 2,
  smooth: { type: "continuous", roundness: 0.2 },
})));

const container = document.getElementById("graph");
const network = new vis.Network(container, { nodes: nodesDs, edges: edgesDs }, {
  physics: {
    enabled: true,
    solver: "forceAtlas2Based",
    forceAtlas2Based: {
      gravitationalConstant: -60,
      centralGravity: 0.005,
      springLength: 140,
      springConstant: 0.06,
      damping: 0.45,
      avoidOverlap: 0.6,
    },
    stabilization: { enabled: true, iterations: 250, updateInterval: 20 },
  },
  interaction: {
    hover: true,
    tooltipDelay: 200,
    navigationButtons: false,
    keyboard: { enabled: true, speed: { x: 10, y: 10, zoom: 0.02 } },
    zoomView: true,
    dragView: true,
  },
  layout: { improvedLayout: rawNodes.length < 400 },
});

network.on("stabilizationIterationsDone", () => {
  network.setOptions({ physics: { enabled: false } });
});

// ── Info panel ──────────────────────────────────────────────────────────────

const infoEl       = document.getElementById("info");
const infoGroupDot = document.getElementById("info-group-dot");
const infoTitle    = document.getElementById("info-title");
const infoBody     = document.getElementById("info-body");
const infoTagsEl   = document.getElementById("info-tags");
const infoConn     = document.getElementById("info-connections");
const openBtn      = document.getElementById("open-btn");

network.on("click", params => {
  if (params.nodes.length > 0) {
    const nid = params.nodes[0];
    const n = rawNodes.find(x => x.id === nid);
    if (!n) return;
    const c = getColor(n.group);

    infoGroupDot.style.background = c.fill;
    infoGroupDot.style.boxShadow = "0 0 8px " + hexToRgba(c.glow, 0.7);
    infoTitle.textContent = n.label;
    infoBody.textContent = n.title || "";
    infoTagsEl.innerHTML = (n.keywords || []).slice(0, 8).map(k =>
      \`<span class="itag" style="color:\${c.fill};border-color:\${hexToRgba(c.fill,0.35)};background:\${hexToRgba(c.fill,0.1)}">\${k}</span>\`
    ).join("");
    const conn = connCount[n.id] ?? 0;
    infoConn.textContent = conn + (conn === 1 ? " connection" : " connections") + "  ·  " + n.group;
    
    // Set up open in editor link (VS Code / Cursor protocol)
    openBtn.href = "vscode://file" + n.path;
    
    infoEl.style.display = "block";
  } else {
    infoEl.style.display = "none";
    network.unselectAll();
  }
});

// Highlight connected nodes on hover
network.on("hoverNode", params => {
  const nid = params.node;
  const connected = network.getConnectedNodes(nid);
  const allIds = rawNodes.map(n => n.id);
  const updates = allIds.map(id => {
    const n = rawNodes.find(x => x.id === id);
    const c = getColor(n.group);
    const conn = connCount[id] ?? 0;
    const size = 7 + Math.min(22, conn * 2.5);
    const isConnected = connected.includes(id) || id === nid;
    return {
      id,
      color: {
        background: isConnected ? c.fill : hexToRgba(c.fill, 0.18),
        border: isConnected ? hexToRgba(c.fill, 0.6) : "transparent",
        highlight: { background: "#ffffff", border: c.fill },
        hover:      { background: "#ffffff", border: c.fill },
      },
      shadow: {
        enabled: true,
        color: id === nid ? hexToRgba(c.glow, 0.8) : hexToRgba(c.glow, isConnected ? 0.45 : 0.1),
        x: 0, y: 0,
        size: id === nid ? size + 14 : size + 5,
      },
      font: { color: isConnected ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.18)" },
    };
  });
  nodesDs.update(updates);
  edgesDs.update(rawEdges.map(e => ({
    id: e.from + "__" + e.to,
    from: e.from, to: e.to,
    color: {
      color: (e.from === nid || e.to === nid) ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.03)",
      highlight: "rgba(255,255,255,0.6)",
    },
    width: (e.from === nid || e.to === nid) ? 2 : 1,
  })));
});

network.on("blurNode", () => {
  const updates = rawNodes.map(n => {
    const c = getColor(n.group);
    const conn = connCount[n.id] ?? 0;
    const size = 7 + Math.min(22, conn * 2.5);
    return {
      id: n.id,
      color: {
        background: c.fill,
        border: hexToRgba(c.fill, 0.4),
        highlight: { background: "#ffffff", border: c.fill },
        hover:      { background: "#ffffff", border: c.fill },
      },
      shadow: { enabled: true, color: hexToRgba(c.glow, 0.55), x: 0, y: 0, size: size + 6 },
      font: { color: "rgba(255,255,255,0.72)" },
    };
  });
  nodesDs.update(updates);
  edgesDs.update(rawEdges.map(e => ({
    id: e.from + "__" + e.to,
    from: e.from, to: e.to,
    color: { color: "rgba(255,255,255,0.06)", highlight: "rgba(255,255,255,0.5)" },
    width: 1,
  })));
});

// ── Search ───────────────────────────────────────────────────────────────────

const searchEl = document.getElementById("search");
searchEl.addEventListener("input", () => {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) {
    // Reset all
    network.emit("blurNode", {});
    return;
  }
  const matched = rawNodes.filter(n => n.label.toLowerCase().includes(q));
  const matchedIds = new Set(matched.map(n => n.id));
  nodesDs.update(rawNodes.map(n => {
    const c = getColor(n.group);
    const conn = connCount[n.id] ?? 0;
    const size = 7 + Math.min(22, conn * 2.5);
    const hit = matchedIds.has(n.id);
    return {
      id: n.id,
      color: {
        background: hit ? c.fill : hexToRgba(c.fill, 0.15),
        border: hit ? hexToRgba(c.fill, 0.7) : "transparent",
        highlight: { background: "#ffffff", border: c.fill },
        hover:      { background: "#ffffff", border: c.fill },
      },
      shadow: { enabled: true, color: hexToRgba(c.glow, hit ? 0.75 : 0.08), x: 0, y: 0, size: hit ? size + 12 : size },
      font: { color: hit ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.15)" },
    };
  }));
  if (matched.length === 1) {
    network.focus(matched[0].id, { scale: 1.4, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
  }
});

// ── Group filter ─────────────────────────────────────────────────────────────

let activeGroup = null;
function filterGroup(group) {
  if (activeGroup === group) {
    activeGroup = null;
    network.emit("blurNode", {});
    return;
  }
  activeGroup = group;
  const inGroup = new Set(rawNodes.filter(n => n.group === group).map(n => n.id));
  nodesDs.update(rawNodes.map(n => {
    const c = getColor(n.group);
    const conn = connCount[n.id] ?? 0;
    const size = 7 + Math.min(22, conn * 2.5);
    const hit = inGroup.has(n.id);
    return {
      id: n.id,
      color: {
        background: hit ? c.fill : hexToRgba(c.fill, 0.12),
        border: hit ? hexToRgba(c.fill, 0.6) : "transparent",
        highlight: { background: "#ffffff", border: c.fill },
        hover:      { background: "#ffffff", border: c.fill },
      },
      shadow: { enabled: true, color: hexToRgba(c.glow, hit ? 0.65 : 0.06), x: 0, y: 0, size: hit ? size + 10 : size },
      font: { color: hit ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.12)" },
    };
  }));
}
</script>
</body>
</html>`;

  await fs.mkdir(dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, "utf-8");
  return { nodeCount: nodes.length, edgeCount: edges.length };
}
