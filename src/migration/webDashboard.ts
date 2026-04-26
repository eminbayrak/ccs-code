// ---------------------------------------------------------------------------
// Static, self-contained HTML dashboard for a CCS migration run.
//
// The output is a single dashboard.html written into the run folder. It needs
// no server: the user just opens the file in any browser. Markdown, Mermaid
// source, JSON, and the system graph are embedded directly in the HTML. The
// dashboard intentionally has no CDN or package dependency so it works in
// locked-down company environments. Light/dark theme uses CSS variables and is
// persisted in localStorage; the OS preference is the initial default.
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import type { ComponentVerification } from "./rewriteVerifier.js";
import type { RunLayout } from "./runLayout.js";

export type DashboardInput = {
  layout: RunLayout;
  repoUrl: string;
  generatedAt: string;
  frameworkInfo: FrameworkInfo;
  analyses: ComponentAnalysis[];
  verifications: ComponentVerification[];
  migrationOrder: string[];
  errors: string[];
};

type ComponentEntry = {
  name: string;
  type: string;
  targetRole: string;
  complexity: string;
  confidence: string;
  verdict: "ready" | "needs_review" | "blocked" | "no_verification";
  verifiedClaims: number;
  totalClaims: number;
  humanQuestions: number;
  dependencies: string[];
  doc: string;          // raw markdown of components/<Name>.md
};

type DashboardData = {
  meta: {
    repo: string;
    repoLabel: string;
    generatedAt: string;
    framework: {
      sourceFramework: string;
      sourceLanguage: string;
      targetFramework: string;
      targetLanguage: string;
      architecturePattern: string;
    };
    posture: { ready: number; needsReview: number; blocked: number };
    pipelineErrors: string[];
    migrationOrder: string[];
  };
  docs: {
    readme: string;
    agents: string;
    architectureBaseline: string;
    preflightReadiness: string;
    componentDispositionMatrix: string;
    humanQuestions: string;
    verificationSummary: string;
    dependencyRiskReport: string;
    testScaffoldsIndex: string;
    reverseEngineeringDetails: string;
    systemGraphMermaid: string;
  };
  components: ComponentEntry[];
  graph: unknown | null;
  businessLogic: unknown | null;
  architectureContextFiles: Array<{ name: string; content: string }>;
  contractJson: unknown | null;
};

async function readOptionalText(path: string): Promise<string> {
  try { return await fs.readFile(path, "utf-8"); } catch { return ""; }
}

async function readOptionalJson(path: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch { return null; }
}

async function readDirOptional(path: string): Promise<string[]> {
  try { return await fs.readdir(path); } catch { return []; }
}

function effectiveVerdict(
  analysis: ComponentAnalysis,
  verification: ComponentVerification | undefined,
): "ready" | "needs_review" | "blocked" | "no_verification" {
  const baseBlocked = analysis.targetRole === "human_review" ||
    analysis.targetRole === "unknown";
  if (baseBlocked) return "blocked";
  const reviewNeeded = analysis.humanQuestions.length > 0 ||
    analysis.confidence === "low" ||
    analysis.sourceCoverage.filesTruncated.length > 0;
  if (!verification) return reviewNeeded ? "needs_review" : "no_verification";
  if (verification.trustVerdict === "blocked") return "blocked";
  if (verification.trustVerdict === "needs_review") return "needs_review";
  return reviewNeeded ? "needs_review" : "ready";
}

async function gatherData(input: DashboardInput): Promise<DashboardData> {
  const { layout, frameworkInfo, analyses, verifications, migrationOrder } = input;
  const verifByName = new Map(verifications.map((v) => [v.component, v]));

  const docs = {
    readme:                     await readOptionalText(layout.readmePath),
    agents:                     await readOptionalText(layout.agentsPath),
    architectureBaseline:       await readOptionalText(layout.architectureBaselinePath),
    preflightReadiness:         await readOptionalText(layout.preflightReadinessPath),
    componentDispositionMatrix: await readOptionalText(layout.dispositionMatrixPath),
    humanQuestions:             await readOptionalText(layout.humanQuestionsPath),
    verificationSummary:        await readOptionalText(layout.verificationSummaryPath),
    dependencyRiskReport:       await readOptionalText(layout.dependencyRiskReportPath),
    testScaffoldsIndex:         await readOptionalText(join(layout.testScaffoldsDir, "README.md")),
    reverseEngineeringDetails:  await readOptionalText(
      join(layout.reverseEngineeringDir, "reverse-engineering-details.md")
    ),
    systemGraphMermaid:         await readOptionalText(layout.systemGraphMermaidPath),
  };

  const components: ComponentEntry[] = [];
  for (const a of analyses) {
    const v = verifByName.get(a.component.name);
    components.push({
      name: a.component.name,
      type: a.component.type,
      targetRole: a.targetRole,
      complexity: a.complexity,
      confidence: a.confidence,
      verdict: effectiveVerdict(a, v),
      verifiedClaims: v?.totals.verified ?? 0,
      totalClaims: v?.totals.claimsChecked ?? 0,
      humanQuestions: a.humanQuestions.length,
      dependencies: a.component.dependencies,
      doc: await readOptionalText(join(layout.componentsDir, `${a.component.name}.md`)),
    });
  }

  const graph         = await readOptionalJson(layout.systemGraphJsonPath);
  const businessLogic = await readOptionalJson(join(layout.reverseEngineeringDir, "business-logic.json"));
  const contractJson  = await readOptionalJson(layout.contractPath);

  const archEntries = await readDirOptional(layout.architectureContextDir);
  const architectureContextFiles: Array<{ name: string; content: string }> = [];
  for (const name of archEntries) {
    const content = await readOptionalText(join(layout.architectureContextDir, name));
    if (content) architectureContextFiles.push({ name, content });
  }

  const ready       = components.filter((c) => c.verdict === "ready").length;
  const needsReview = components.filter((c) => c.verdict === "needs_review").length;
  const blocked     = components.filter((c) => c.verdict === "blocked").length;

  return {
    meta: {
      repo: input.repoUrl,
      repoLabel: input.repoUrl.split("/").slice(-2).join("/"),
      generatedAt: input.generatedAt,
      framework: {
        sourceFramework:    frameworkInfo.sourceFramework,
        sourceLanguage:     frameworkInfo.sourceLanguage,
        targetFramework:    frameworkInfo.targetFramework,
        targetLanguage:     frameworkInfo.targetLanguage,
        architecturePattern: frameworkInfo.architecturePattern,
      },
      posture: { ready, needsReview, blocked },
      pipelineErrors: input.errors,
      migrationOrder,
    },
    docs,
    components,
    graph,
    businessLogic,
    architectureContextFiles,
    contractJson,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Embed JSON safely in a <script type="application/json"> block. We escape
 * "</" so a stray closing tag inside a string can't break out of the block.
 */
function jsonScript(id: string, value: unknown): string {
  const json = JSON.stringify(value).replace(/<\/(script)/gi, "<\\/$1");
  return `<script id="${id}" type="application/json">${json}</script>`;
}

const STYLE = `
:root {
  /* Light theme — clean, GitHub-ish */
  --bg: #ffffff;
  --bg-elev: #f7f8fb;
  --bg-card: #ffffff;
  --fg: #1a1d27;
  --fg-muted: #545a6b;
  --fg-dim: #8b91a3;
  --border: #e3e6ee;
  --border-strong: #cdd2de;
  --accent: #3b6cf6;
  --accent-bg: #eef2ff;
  --ready: #1b8a3a;
  --ready-bg: #e6f5ec;
  --needs: #b35c00;
  --needs-bg: #fdf2dc;
  --blocked: #b3251f;
  --blocked-bg: #fce8e6;
  --code-bg: #f4f6fa;
  --row-tint: rgba(15,18,25,.025);
  --shadow: 0 1px 2px rgba(20,23,31,.04), 0 4px 16px rgba(20,23,31,.04);

  /* Graph workspace — light mode */
  --graph-bg: #f8fafc;
  --graph-grid: rgba(15,23,42,.06);
  --graph-glow-1: rgba(59,108,246,.06);
  --graph-glow-2: rgba(74,222,128,.05);
  --graph-glow-3: rgba(245,158,11,.04);
  --graph-panel: #ffffff;
  --graph-panel-2: #f7f8fb;
  --graph-border: #e3e6ee;
  --graph-fg: #1a1d27;
  --graph-muted: #6b7488;
  --graph-accent: #3b6cf6;
  --graph-accent-soft: rgba(59,108,246,.16);
  --graph-edge-default: rgba(71,85,105,.30);
  --graph-edge-target: rgba(22,163,74,.34);
  --graph-edge-package: rgba(124,58,237,.32);
  --graph-edge-active: rgba(59,108,246,.95);
  --graph-label-bg: #ffffff;
  --graph-label-fg: #1a1d27;
  --graph-label-border: rgba(15,23,42,.18);

  /* JSON viewer — readable on light bg */
  --json-key: #1d4ed8;
  --json-string: #047857;
  --json-number: #b45309;
  --json-boolean: #7c3aed;
  --json-null: #64748b;
  --json-punc: #475569;
}

[data-theme="dark"] {
  /* Dark theme — Linear / GitNexus-ish */
  --bg: #0f1218;
  --bg-elev: #161a23;
  --bg-card: #1a1f2b;
  --fg: #e6e9f1;
  --fg-muted: #a4abbb;
  --fg-dim: #6c7588;
  --border: #262d3c;
  --border-strong: #38415a;
  --accent: #7c9bff;
  --accent-bg: #1e2a4d;
  --ready: #4ad57a;
  --ready-bg: #143b22;
  --needs: #f0b057;
  --needs-bg: #3b2c12;
  --blocked: #ff7872;
  --blocked-bg: #3d1614;
  --code-bg: #11151d;
  --row-tint: rgba(255,255,255,.03);
  --shadow: 0 1px 2px rgba(0,0,0,.2), 0 8px 24px rgba(0,0,0,.25);

  /* Graph workspace — dark mode (GitNexus canvas) */
  --graph-bg: #05070d;
  --graph-grid: rgba(99,118,160,.10);
  --graph-glow-1: rgba(34,211,238,.08);
  --graph-glow-2: rgba(124,58,237,.09);
  --graph-glow-3: rgba(245,158,11,.06);
  --graph-panel: #0b0e16;
  --graph-panel-2: #111522;
  --graph-border: #252b3f;
  --graph-fg: #f1f5ff;
  --graph-muted: #828b9d;
  --graph-accent: #22d3ee;
  --graph-accent-soft: rgba(34,211,238,.14);
  --graph-edge-default: rgba(96,165,250,.20);
  --graph-edge-target: rgba(74,222,128,.28);
  --graph-edge-package: rgba(192,132,252,.26);
  --graph-edge-active: rgba(34,211,238,.95);
  --graph-label-bg: rgba(6,10,18,.88);
  --graph-label-fg: #f1f5ff;
  --graph-label-border: rgba(34,211,238,.42);

  /* JSON viewer — readable on dark bg */
  --json-key: #93c5fd;
  --json-string: #86efac;
  --json-number: #fbbf24;
  --json-boolean: #c4b5fd;
  --json-null: #94a3b8;
  --json-punc: #8b95a7;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
  background: var(--bg);
  color: var(--fg);
  font-size: 14.5px;
  line-height: 1.55;
}

.app { display: grid; grid-template-columns: 260px 1fr; height: 100vh; }
.sidebar {
  border-right: 1px solid var(--border);
  background: var(--bg-elev);
  overflow-y: auto;
  display: flex; flex-direction: column;
}
.sidebar-head { padding: 18px 18px 12px; border-bottom: 1px solid var(--border); }
.sidebar-head h1 {
  font-size: 13px; margin: 0 0 2px; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--fg-muted);
}
.sidebar-head .repo {
  font-size: 14px; font-weight: 600; color: var(--fg);
  word-break: break-all;
}
.sidebar-head .meta { font-size: 12px; color: var(--fg-dim); margin-top: 4px; }

.nav { padding: 12px 8px; flex: 1; }
.nav-section { font-size: 11px; color: var(--fg-dim); text-transform: uppercase;
  letter-spacing: 0.06em; padding: 12px 12px 6px; }
.nav a {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 12px; border-radius: 6px; text-decoration: none; color: var(--fg);
  font-size: 14px; cursor: pointer;
}
.nav a:hover { background: var(--bg-card); }
.nav a.active { background: var(--accent-bg); color: var(--accent); font-weight: 500; }
.nav .badge { font-size: 11px; padding: 2px 7px; border-radius: 999px;
  background: var(--bg-card); color: var(--fg-muted); border: 1px solid var(--border); }
.nav a.active .badge { background: var(--accent); color: white; border-color: transparent; }

.sidebar-foot { padding: 14px 18px; border-top: 1px solid var(--border);
  display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--fg-dim); }
.theme-toggle {
  background: transparent; border: 1px solid var(--border); color: var(--fg-muted);
  border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px;
}
.theme-toggle:hover { border-color: var(--border-strong); color: var(--fg); }

.main { overflow-y: auto; padding: 32px 40px 80px; }
.main h1 { font-size: 22px; margin: 0 0 4px; }
.main h2 { font-size: 16px; margin: 28px 0 10px; }
.main h3 { font-size: 14px; margin: 22px 0 8px; color: var(--fg-muted); }
.main p { margin: 8px 0; }

.posture {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 18px 0 24px;
}
.posture .stat {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 16px; box-shadow: var(--shadow);
}
.posture .stat .num { font-size: 28px; font-weight: 700; line-height: 1.1; }
.posture .stat .label { font-size: 12px; color: var(--fg-muted); margin-top: 4px;
  text-transform: uppercase; letter-spacing: 0.05em; }
.posture .stat.ready .num   { color: var(--ready); }
.posture .stat.needs .num   { color: var(--needs); }
.posture .stat.blocked .num { color: var(--blocked); }

.card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
  padding: 16px 20px; box-shadow: var(--shadow); margin: 12px 0;
}

table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
th { font-weight: 600; color: var(--fg-muted); font-size: 12px;
  text-transform: uppercase; letter-spacing: 0.04em; background: var(--bg-elev); }
tbody tr:nth-child(even) td { background: var(--row-tint); }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: var(--accent-bg); }

.verdict {
  display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px;
  border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em;
}
.verdict.ready   { background: var(--ready-bg);   color: var(--ready);   }
.verdict.needs_review { background: var(--needs-bg); color: var(--needs); }
.verdict.blocked { background: var(--blocked-bg); color: var(--blocked); }
.verdict.no_verification { background: var(--bg-elev); color: var(--fg-muted); }

.markdown { line-height: 1.65; }
.markdown h1 { font-size: 22px; margin: 0 0 12px; }
.markdown h2 { font-size: 16px; margin: 28px 0 10px; padding-bottom: 6px;
  border-bottom: 1px solid var(--border); }
.markdown h3 { font-size: 14px; margin: 20px 0 8px; }
.markdown a { color: var(--accent); }
.markdown code { background: var(--code-bg); padding: 1px 6px; border-radius: 4px;
  font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
.markdown pre { background: var(--code-bg); padding: 12px 14px; border-radius: 8px;
  overflow-x: auto; font-size: 12.5px; line-height: 1.5;
  border: 1px solid var(--border); }
.markdown pre code { background: transparent; padding: 0; }
.markdown table { margin: 12px 0; }
.markdown blockquote { margin: 10px 0; padding: 6px 14px; border-left: 3px solid var(--border-strong);
  color: var(--fg-muted); background: var(--bg-elev); border-radius: 0 6px 6px 0; }
.markdown ul, .markdown ol { padding-left: 22px; }

.graph-workspace {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 330px;
  gap: 0;
  height: calc(100vh - 210px);
  min-height: 640px;
  overflow: hidden;
  border: 1px solid var(--graph-border);
  border-radius: 14px;
  background: var(--graph-bg);
  box-shadow: var(--shadow);
}
.graph-filter-panel,
.graph-panel {
  background: var(--graph-panel);
  color: var(--graph-fg);
  border-color: var(--graph-border);
}
[data-theme="dark"] .graph-filter-panel,
[data-theme="dark"] .graph-panel {
  background: linear-gradient(180deg, var(--graph-panel-2), var(--graph-panel));
}
.graph-filter-panel {
  border-right: 1px solid var(--graph-border);
  padding: 14px 12px;
  overflow: auto;
}
.graph-filter-panel h3,
.graph-panel h3 {
  margin: 18px 0 8px;
  color: var(--graph-muted);
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.graph-filter-panel h3:first-child,
.graph-panel h3:first-child { margin-top: 0; }
.graph-filter-panel .hint {
  color: var(--graph-muted);
  font-size: 12px;
  margin: 4px 0 12px;
}
.graph-filter-list {
  display: grid;
  gap: 7px;
}
.graph-main-panel {
  min-width: 0;
  display: grid;
  grid-template-rows: auto 1fr;
  background: var(--graph-bg);
}
.graph-topbar {
  min-height: 50px;
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--graph-border);
  background: var(--graph-panel);
  backdrop-filter: blur(6px);
}
[data-theme="dark"] .graph-topbar {
  background: rgba(9,12,20,.78);
}
.graph-title {
  color: var(--graph-fg);
  font-weight: 700;
  font-size: 13px;
}
.graph-counts {
  color: var(--graph-muted);
  font-size: 12px;
  white-space: nowrap;
}
#graph-host {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 45%, var(--graph-glow-1), transparent 26%),
    radial-gradient(circle at 15% 20%, var(--graph-glow-2), transparent 26%),
    radial-gradient(circle at 84% 78%, var(--graph-glow-3), transparent 28%),
    var(--graph-bg);
}
#graph-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
}
#graph-canvas.dragging { cursor: grabbing; }
.graph-panel {
  border-left: 1px solid var(--graph-border);
  padding: 14px;
  overflow: auto;
}
.graph-panel h2 { margin: 4px 0 8px; color: var(--graph-fg); font-size: 18px; }
.graph-panel .kv { display: grid; grid-template-columns: 92px 1fr; gap: 6px 10px; font-size: 13px; }
.graph-panel .kv span:nth-child(odd) { color: var(--graph-muted); }
.graph-panel code {
  background: var(--graph-accent-soft);
  border: 1px solid var(--graph-accent-soft);
  color: var(--graph-accent);
  border-radius: 5px;
  padding: 1px 5px;
}
.graph-panel a { color: var(--graph-accent); }
.graph-panel ul { padding-left: 18px; color: var(--graph-muted); }
.graph-panel li { margin: 6px 0; }
.inspector-kicker {
  color: var(--graph-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.node-type-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--graph-fg);
  border: 1px solid var(--graph-border);
  background: var(--graph-panel-2);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 12px;
  margin: 0 0 12px;
}
.node-type-pill::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--node-dot, var(--graph-accent));
}
.graph-search {
  width: 100%;
  border: 1px solid var(--graph-border);
  border-radius: 8px;
  background: var(--graph-panel-2);
  color: var(--graph-fg);
  padding: 8px 10px;
  font-size: 13px;
  outline: none;
}
.graph-search:focus {
  border-color: var(--graph-accent);
  box-shadow: 0 0 0 3px var(--graph-accent-soft);
}
.graph-toolbar { display: grid; gap: 7px; align-items: center; }
.graph-toolbar .chip {
  font-size: 12px;
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid var(--graph-border);
  background: var(--graph-panel-2);
  color: var(--graph-muted);
  user-select: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.graph-toolbar .chip:hover {
  color: var(--graph-fg);
  border-color: var(--graph-accent);
}
.graph-toolbar .chip.active {
  color: var(--graph-accent);
  border-color: var(--graph-accent);
  background: var(--graph-accent-soft);
}
.graph-legend { display: grid; gap: 7px; margin: 8px 0 14px; color: var(--graph-muted); font-size: 12px; }
.graph-legend span::before {
  content: "";
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  margin-right: 5px;
  background: var(--dot);
}
.graph-controls {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: grid;
  gap: 8px;
}
.graph-controls button {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--graph-border);
  background: var(--graph-panel);
  color: var(--graph-fg);
  cursor: pointer;
  font-weight: 700;
  box-shadow: var(--shadow);
}
.graph-controls button:hover {
  border-color: var(--graph-accent);
  color: var(--graph-accent);
}
.graph-watermark {
  position: absolute;
  left: 14px;
  bottom: 12px;
  color: var(--graph-muted);
  opacity: .7;
  font-size: 11px;
  pointer-events: none;
}

.banner-error {
  background: var(--blocked-bg); color: var(--blocked); border: 1px solid var(--blocked);
  border-radius: 8px; padding: 10px 14px; margin: 12px 0; font-size: 13px;
}
.json-viewer {
  max-height: 70vh;
  overflow: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0;
  box-shadow: var(--shadow);
}
.json-pre {
  margin: 0;
  padding: 14px 16px;
  color: var(--json-punc);
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.58;
  tab-size: 2;
}
.json-key { color: var(--json-key); font-weight: 600; }
.json-string { color: var(--json-string); }
.json-number { color: var(--json-number); }
.json-boolean { color: var(--json-boolean); font-weight: 600; }
.json-null { color: var(--json-null); font-style: italic; }
.json-punc { color: var(--json-punc); }
.json-viewer::-webkit-scrollbar,
#graph-host::-webkit-scrollbar,
.graph-panel::-webkit-scrollbar,
.graph-filter-panel::-webkit-scrollbar { width: 10px; height: 10px; }
.json-viewer::-webkit-scrollbar-thumb,
#graph-host::-webkit-scrollbar-thumb,
.graph-panel::-webkit-scrollbar-thumb,
.graph-filter-panel::-webkit-scrollbar-thumb {
  background: rgba(148,163,184,.35);
  border-radius: 999px;
}
.mermaid-render {
  overflow: auto;
  min-height: 360px;
  background:
    radial-gradient(circle at 14% 12%, var(--accent-bg), transparent 28%),
    radial-gradient(circle at 84% 78%, var(--ready-bg), transparent 32%),
    var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  box-shadow: var(--shadow);
}
.mermaid-render svg {
  display: block;
  min-width: 760px;
  max-width: none;
}
.mermaid-render .empty {
  color: var(--fg-muted);
  padding: 24px;
}
.mermaid-node rect {
  stroke-width: 1.6;
  filter: drop-shadow(0 5px 10px rgba(20,23,31,.08));
}
[data-theme="dark"] .mermaid-node rect {
  filter: drop-shadow(0 5px 12px rgba(0,0,0,.45));
}
.mermaid-node text {
  font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  fill: #172033;
}
.mermaid-edge {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 1.6;
}
.mermaid-edge.dotted { stroke-dasharray: 6 5; }
.mermaid-label {
  font: 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  fill: var(--fg-muted);
}
.source-details {
  margin: 12px 0 20px;
}
.source-details summary {
  cursor: pointer;
  color: var(--fg-muted);
  font-size: 13px;
  user-select: none;
}
.source-details summary:hover { color: var(--fg); }
.mermaid-source {
  white-space: pre;
  overflow: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.meta-line { color: var(--fg-muted); font-size: 13px; }
.muted { color: var(--fg-muted); }

@media (max-width: 800px) {
  .app { grid-template-columns: 1fr; }
  .sidebar { display: none; }
  .main { padding: 16px; }
  .graph-workspace { grid-template-columns: 1fr; height: auto; }
  .graph-filter-panel, .graph-panel { border: 0; border-bottom: 1px solid var(--graph-border); }
  #graph-host { height: 560px; }
}
`;

const SCRIPT = `
const data = JSON.parse(document.getElementById('ccs-data').textContent);
const themeKey = 'ccs-dashboard-theme';

// ----- Theme handling --------------------------------------------------------
function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = name === 'dark' ? '☀ Light' : '☾ Dark';
  try { localStorage.setItem(themeKey, name); } catch (_) {}
}
function initialTheme() {
  try {
    const saved = localStorage.getItem(themeKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (_) {}
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
applyTheme(initialTheme());

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.id === 'theme-toggle') {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
    // Theme tokens just changed — repaint anything we rasterized with old colors.
    if (typeof drawGraph === 'function' && document.getElementById('graph-canvas')) {
      try { drawGraph(); } catch (_) {}
    }
    // Re-render Mermaid by re-running the active route renderer.
    if (typeof renderRoute === 'function') {
      try { renderRoute(); } catch (_) {}
    }
  }
});

// ----- Markdown rendering ----------------------------------------------------
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function inlineMarkdown(text) {
  return escapeText(text)
    .replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderTable(lines) {
  const rows = lines
    .filter((line) => line.trim().startsWith('|') && line.trim().endsWith('|'))
    .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim()));
  if (rows.length === 0) return '';
  const header = rows[0] || [];
  const body = rows.slice(rows[1]?.every((cell) => /^:?-{3,}:?$/.test(cell)) ? 2 : 1);
  return '<table><thead><tr>' + header.map((cell) => '<th>' + inlineMarkdown(cell) + '</th>').join('') +
    '</tr></thead><tbody>' + body.map((row) =>
      '<tr>' + row.map((cell) => '<td>' + inlineMarkdown(cell) + '</td>').join('') + '</tr>'
    ).join('') + '</tbody></table>';
}

function renderMarkdown(md) {
  if (!md) return '<p class="muted">_(empty)_</p>';
  const lines = String(md).replace(/\\r\\n/g, '\\n').split('\\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || '';

    const fence = line.match(/^\\\`\\\`\\\`(\\w+)?\\s*$/);
    if (fence) {
      const lang = (fence[1] || '').toLowerCase();
      const code = [];
      i++;
      while (i < lines.length && !/^\\\`\\\`\\\`\\s*$/.test(lines[i] || '')) code.push(lines[i++] || '');
      i++;
      const cls = lang === 'mermaid' || lang === 'mmd' ? 'mermaid-source' : '';
      out.push('<pre class="' + cls + '"><code>' + escapeText(code.join('\\n')) + '</code></pre>');
      continue;
    }

    if (/^\\s*$/.test(line)) { i++; continue; }

    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const table = [];
      while (i < lines.length && lines[i]?.trim().startsWith('|') && lines[i]?.trim().endsWith('|')) {
        table.push(lines[i++] || '');
      }
      out.push(renderTable(table));
      continue;
    }

    const heading = line.match(/^(#{1,4})\\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      out.push('<h' + level + ' id="' + slugify(text) + '">' + inlineMarkdown(text) + '</h' + level + '>');
      i++;
      continue;
    }

    if (/^>\\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\\s?/.test(lines[i] || '')) {
        quote.push((lines[i++] || '').replace(/^>\\s?/, ''));
      }
      out.push('<blockquote>' + quote.map(inlineMarkdown).join('<br>') + '</blockquote>');
      continue;
    }

    if (/^\\s*[-*]\\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i] || '')) {
        items.push((lines[i++] || '').replace(/^\\s*[-*]\\s+/, ''));
      }
      out.push('<ul>' + items.map((item) => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</ul>');
      continue;
    }

    if (/^\\s*\\d+\\.\\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i] || '')) {
        items.push((lines[i++] || '').replace(/^\\s*\\d+\\.\\s+/, ''));
      }
      out.push('<ol>' + items.map((item) => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</ol>');
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      !/^\\s*$/.test(lines[i] || '') &&
      !/^(#{1,4})\\s+/.test(lines[i] || '') &&
      !/^\\s*[-*]\\s+/.test(lines[i] || '') &&
      !/^\\s*\\d+\\.\\s+/.test(lines[i] || '') &&
      !/^>\\s?/.test(lines[i] || '') &&
      !((lines[i] || '').trim().startsWith('|') && (lines[i] || '').trim().endsWith('|')) &&
      !/^\\\`\\\`\\\`/.test(lines[i] || '')
    ) {
      para.push(lines[i++] || '');
    }
    out.push('<p>' + inlineMarkdown(para.join(' ')) + '</p>');
  }
  return out.join('\\n');
}

// ----- Routing ---------------------------------------------------------------
let currentRoute = location.hash.slice(1) || 'overview';

function setRoute(name) {
  currentRoute = name;
  if (location.hash.slice(1) !== name) location.hash = name;
  renderRoute();
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === name || (name.startsWith('component:') && a.dataset.route === 'components'));
  });
}

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1) || 'overview';
  if (h !== currentRoute) setRoute(h);
});

// ----- Section renderers -----------------------------------------------------
const main = document.getElementById('main');

function renderOverview() {
  const m = data.meta;
  const reverseLink = data.docs.reverseEngineeringDetails ? '<a href="#reverse">Reverse engineering</a> · ' : '';
  return \`
    <h1>\${m.repoLabel}</h1>
    <div class="meta-line">\${m.framework.sourceFramework} (\${m.framework.sourceLanguage}) → \${m.framework.targetFramework} (\${m.framework.targetLanguage}) · generated \${new Date(m.generatedAt).toLocaleString()}</div>

    <div class="posture">
      <div class="stat ready"><div class="num">\${m.posture.ready}</div><div class="label">Ready</div></div>
      <div class="stat needs"><div class="num">\${m.posture.needsReview}</div><div class="label">Needs review</div></div>
      <div class="stat blocked"><div class="num">\${m.posture.blocked}</div><div class="label">Blocked</div></div>
    </div>

    \${m.pipelineErrors.length > 0 ? '<div class="banner-error">' + m.pipelineErrors.length + ' pipeline error(s): ' + m.pipelineErrors.map(escapeText).join('; ') + '</div>' : ''}

    <div class="card markdown" id="readme-render">\${renderMarkdown(data.docs.readme || '_README missing._')}</div>
  \`;
}

function escapeText(s) { return String(s).replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

function jsonWhitespace(ch) {
  return ch === ' ' || ch === '\\n' || ch === '\\r' || ch === '\\t';
}

function jsonNumberChar(ch) {
  return (ch >= '0' && ch <= '9') || ch === '-' || ch === '+' || ch === '.' || ch === 'e' || ch === 'E';
}

function renderJson(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  let html = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] === '\\\\\\\\') { j += 2; continue; }
        if (raw[j] === '"') { j++; break; }
        j++;
      }
      const token = raw.slice(i, j);
      let k = j;
      while (jsonWhitespace(raw[k])) k++;
      const cls = raw[k] === ':' ? 'json-key' : 'json-string';
      html += '<span class="' + cls + '">' + escapeText(token) + '</span>';
      i = j;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < raw.length && jsonNumberChar(raw[j])) j++;
      html += '<span class="json-number">' + escapeText(raw.slice(i, j)) + '</span>';
      i = j;
      continue;
    }
    if (raw.startsWith('true', i) || raw.startsWith('false', i)) {
      const token = raw.startsWith('true', i) ? 'true' : 'false';
      html += '<span class="json-boolean">' + token + '</span>';
      i += token.length;
      continue;
    }
    if (raw.startsWith('null', i)) {
      html += '<span class="json-null">null</span>';
      i += 4;
      continue;
    }
    if ('{}[]:,'.includes(ch)) {
      html += '<span class="json-punc">' + escapeText(ch) + '</span>';
      i++;
      continue;
    }
    html += escapeText(ch);
    i++;
  }
  return '<div class="json-viewer"><pre class="json-pre"><code>' + html + '</code></pre></div>';
}

function renderTrustGate() {
  const rows = data.components.map((c) => \`
    <tr class="clickable" onclick="window.location.hash = 'component:\${encodeURIComponent(c.name)}'">
      <td><strong>\${escapeText(c.name)}</strong></td>
      <td><span class="verdict \${c.verdict}">\${c.verdict.replace('_', ' ')}</span></td>
      <td>\${c.verifiedClaims}/\${c.totalClaims}</td>
      <td>\${c.humanQuestions}</td>
      <td>\${escapeText(c.targetRole)}</td>
    </tr>
  \`).join('');
  return \`
    <h1>Trust Gate</h1>
    <p>Click any row to open the per-component analysis with the full verification audit.</p>
    <div class="card"><table>
      <thead><tr><th>Component</th><th>Verdict</th><th>Verified claims</th><th>Open Qs</th><th>Target role</th></tr></thead>
      <tbody>\${rows || '<tr><td colspan="5" style="color: var(--fg-dim);">No components analyzed.</td></tr>'}</tbody>
    </table></div>
    <h2>Verification summary (raw)</h2>
    <div class="card markdown">\${renderMarkdown(data.docs.verificationSummary || '_(empty)_')}</div>
  \`;
}

function renderComponents() {
  const rows = data.components.map((c) => \`
    <tr class="clickable" onclick="window.location.hash = 'component:\${encodeURIComponent(c.name)}'">
      <td><strong>\${escapeText(c.name)}</strong></td>
      <td>\${escapeText(c.type)}</td>
      <td><span class="verdict \${c.verdict}">\${c.verdict.replace('_', ' ')}</span></td>
      <td>\${escapeText(c.targetRole)}</td>
      <td>\${escapeText(c.complexity)}</td>
      <td>\${(c.dependencies || []).map(escapeText).join(', ') || '—'}</td>
    </tr>
  \`).join('');
  return \`
    <h1>Components</h1>
    <p>One row per analyzed component. Click for the full source-cited context doc.</p>
    <div class="card"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Verdict</th><th>Target role</th><th>Complexity</th><th>Depends on</th></tr></thead>
      <tbody>\${rows || '<tr><td colspan="6" style="color: var(--fg-dim);">No components.</td></tr>'}</tbody>
    </table></div>
  \`;
}

function renderComponent(name) {
  const c = data.components.find((x) => x.name === name);
  if (!c) return '<h1>Unknown component</h1><p>Use the Components nav item.</p>';
  return \`
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <h1 style="margin:0;">\${escapeText(c.name)}</h1>
      <span class="verdict \${c.verdict}">\${c.verdict.replace('_', ' ')}</span>
    </div>
    <div class="meta-line" style="color: var(--fg-muted); margin-top:4px;">\${escapeText(c.type)} · target role <code>\${escapeText(c.targetRole)}</code> · \${c.verifiedClaims}/\${c.totalClaims} claims verified · \${c.humanQuestions} open question(s)</div>
    <div class="card markdown" style="margin-top:18px;">\${renderMarkdown(c.doc || '_(no context doc)_')}</div>
  \`;
}

function renderGraph() {
  const nodeCount = data.graph?.nodes?.length || 0;
  const edgeCount = data.graph?.edges?.length || 0;
  return \`
    <h1>System Graph</h1>
    <p>Explore the migration graph by component, file, package, and target architecture role.</p>
    <div class="graph-workspace">
      <aside class="graph-filter-panel">
        <h3>Search</h3>
        <input class="graph-search" id="graph-search" placeholder="Search nodes..." />
        <p class="hint">Click a node to inspect dependencies and open its component report.</p>
        <h3>Filters</h3>
        <div class="graph-toolbar" id="graph-toolbar">
          <span class="chip active" data-filter="all">All <span>\${nodeCount}</span></span>
          <span class="chip" data-filter="component">Components</span>
          <span class="chip" data-filter="source_file">Source files</span>
          <span class="chip" data-filter="target_role">Target roles</span>
          <span class="chip" data-filter="source_package">Source packages</span>
          <span class="chip" data-filter="target_package">Target packages</span>
        </div>
        <h3>Legend</h3>
        <div class="graph-legend">
          <span style="--dot:#67e8f9;">component</span>
          <span style="--dot:#94a3b8;">source file</span>
          <span style="--dot:#4ade80;">target role</span>
          <span style="--dot:#c084fc;">source package</span>
          <span style="--dot:#f59e0b;">target package</span>
        </div>
      </aside>
      <section class="graph-main-panel">
        <div class="graph-topbar">
          <div>
            <div class="graph-title">Code Graph</div>
            <div class="graph-counts">\${nodeCount} nodes · \${edgeCount} edges</div>
          </div>
          <div class="graph-counts">drag to pan · scroll to zoom · double-click to fit</div>
        </div>
        <div id="graph-host">
          <canvas id="graph-canvas" aria-label="Interactive system graph"></canvas>
          <div class="graph-controls">
            <button type="button" data-graph-action="zoom-in" title="Zoom in">+</button>
            <button type="button" data-graph-action="zoom-out" title="Zoom out">−</button>
            <button type="button" data-graph-action="reset" title="Fit graph">⌂</button>
          </div>
          <div class="graph-watermark">CCS graph</div>
        </div>
      </section>
      <aside class="graph-panel" id="graph-detail"></aside>
    </div>
    <h2>Mermaid diagram</h2>
    <div class="mermaid-render" id="mermaid-render"></div>
    <details class="source-details">
      <summary>Show Mermaid source</summary>
      <div class="mermaid-source">\${escapeText(data.docs.systemGraphMermaid || 'No system-graph.mmd was generated.')}</div>
    </details>
    <h2>system-graph.json</h2>
    \${renderJson(data.graph || {})}
  \`;
}

function renderArchitecture() {
  const ctxFiles = data.architectureContextFiles.map((f) => \`
    <div class="card markdown">
      <h3 style="margin-top:0;">\${escapeText(f.name)}</h3>
      \${renderMarkdown(f.content)}
    </div>
  \`).join('') || '<div class="card" style="color: var(--fg-muted);">No --context docs were provided for this run.</div>';

  return \`
    <h1>Architecture &amp; Context</h1>
    <h2>Architecture baseline</h2>
    <div class="card markdown">\${renderMarkdown(data.docs.architectureBaseline || '_(empty)_')}</div>
    <h2>Preflight readiness</h2>
    <div class="card markdown">\${renderMarkdown(data.docs.preflightReadiness || '_(empty)_')}</div>
    <h2>Component disposition matrix</h2>
    <div class="card markdown">\${renderMarkdown(data.docs.componentDispositionMatrix || '_(empty)_')}</div>
    <h2>Architecture context (your inputs)</h2>
    \${ctxFiles}
  \`;
}

function renderReverse() {
  const bl = data.businessLogic ? renderJson(data.businessLogic) : '<p style="color: var(--fg-muted);">_(no business-logic.json)_</p>';
  return \`
    <h1>Reverse Engineering</h1>
    <h2>Details</h2>
    <div class="card markdown">\${renderMarkdown(data.docs.reverseEngineeringDetails || '_(empty)_')}</div>
    <h2>business-logic.json</h2>
    \${bl}
  \`;
}

function renderHumanQuestions() {
  return \`
    <h1>Human Questions</h1>
    <p>Decisions an architect or product owner must answer before the corresponding component can move from <span class="verdict blocked">blocked</span> or <span class="verdict needs_review">needs review</span> to <span class="verdict ready">ready</span>.</p>
    <div class="card markdown">\${renderMarkdown(data.docs.humanQuestions || '_(empty)_')}</div>
  \`;
}

function renderAgents() {
  return \`
    <h1>Agent Handoff</h1>
    <p>This page is the agent entry point. Codex auto-reads <code>AGENTS.md</code> from the run folder; Claude Code can use the slash commands generated under <code>claude-commands/</code>.</p>
    <div class="card markdown">\${renderMarkdown(data.docs.agents || '_(empty)_')}</div>
  \`;
}

function renderValidationRisk() {
  return \`
    <h1>Validation &amp; Dependency Risk</h1>
    <p>Enterprise handoff material for coding agents and reviewers: parity-test starting points plus deterministic dependency inventory and security-sensitive package notes.</p>
    <h2>Parity test scaffolds</h2>
    <div class="card markdown">\${renderMarkdown(data.docs.testScaffoldsIndex || '_(no test scaffolds generated)_')}</div>
    <h2>Dependency risk report</h2>
    <div class="card markdown">\${renderMarkdown(data.docs.dependencyRiskReport || '_(no dependency risk report generated)_')}</div>
  \`;
}

function renderRaw() {
  return \`
    <h1>Migration Contract</h1>
    <p>The full machine-readable contract Codex / Claude / MCP read.</p>
    \${renderJson(data.contractJson || { message: 'No migration contract was generated.' })}
  \`;
}

// ----- Graph (Sigma-style canvas, no external library) ----------------------
const NODE_COLORS = {
  component:        '#67e8f9',
  source_file:      '#94a3b8',
  target_role:      '#4ade80',
  source_package:   '#c084fc',
  target_package:   '#f59e0b',
};

let graphState = {
  filter: 'all',
  search: '',
  nodes: [],
  edges: [],
  selectedId: null,
  hoveredId: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  dragNodeId: null,
  lastX: 0,
  lastY: 0,
};

function hashString(value) {
  let h = 2166136261;
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function nodeColor(node) {
  if (node.type === 'component') {
    const component = data.components.find((c) => c.name === node.label);
    if (component?.verdict === 'ready') return '#4ade80';
    if (component?.verdict === 'needs_review') return '#f59e0b';
    if (component?.verdict === 'blocked') return '#f87171';
  }
  return NODE_COLORS[node.type] || '#60a5fa';
}

function visibleGraph(filter, search) {
  const q = (search || '').trim().toLowerCase();
  const nodes = (data.graph?.nodes || [])
    .filter((n) => filter === 'all' || n.type === filter)
    .filter((n) => !q || String(n.label || n.id).toLowerCase().includes(q) || String(n.type || '').toLowerCase().includes(q));
  const allowed = new Set(nodes.map((n) => n.id));
  const edges = (data.graph?.edges || []).filter((e) => allowed.has(e.source) && allowed.has(e.target));
  return { nodes, edges };
}

function layoutCanvasGraph(nodes, edges) {
  const typeOrder = ['component', 'source_file', 'target_role', 'source_package', 'target_package'];
  const typeAngle = new Map(typeOrder.map((type, i) => [type, (-Math.PI / 2) + i * ((Math.PI * 2) / typeOrder.length)]));
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  const positioned = nodes.map((n, index) => {
    const base = typeAngle.get(n.type) ?? (index * 2.399);
    const jitter = (hashString(n.id) % 1000) / 1000;
    const radius = 150 + (hashString(n.label || n.id) % 260);
    return {
      ...n,
      x: Math.cos(base + jitter * 0.8) * radius,
      y: Math.sin(base + jitter * 0.8) * radius,
      vx: 0,
      vy: 0,
      size: Math.max(5, Math.min(18, 6 + Math.sqrt(degree.get(n.id) || 1) * 3)),
      color: nodeColor(n),
    };
  });
  const byId = new Map(positioned.map((n) => [n.id, n]));

  // Lightweight force pass. It gives the dense organic look GitNexus gets
  // from Sigma/Graphology, without shipping an external dependency.
  for (let iter = 0; iter < 120; iter++) {
    for (let i = 0; i < positioned.length; i++) {
      for (let j = i + 1; j < positioned.length; j++) {
        const a = positioned[i], b = positioned[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy + 0.01;
        const force = Math.min(2200 / dist2, 2.8);
        const dist = Math.sqrt(dist2);
        dx /= dist; dy /= dist;
        a.vx += dx * force; a.vy += dy * force;
        b.vx -= dx * force; b.vy -= dy * force;
      }
    }
    for (const e of edges) {
      const a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const desired = 130;
      const force = (dist - desired) * 0.012;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    for (const n of positioned) {
      n.vx += -n.x * 0.002;
      n.vy += -n.y * 0.002;
      n.x += n.vx;
      n.y += n.vy;
      n.vx *= 0.72;
      n.vy *= 0.72;
    }
  }

  return positioned;
}

function buildGraph(filter = graphState.filter) {
  const host = document.getElementById('graph-host');
  const canvas = document.getElementById('graph-canvas');
  const detail = document.getElementById('graph-detail');
  if (!host || !canvas || !detail) return;
  if (!data.graph || !Array.isArray(data.graph.nodes)) {
    host.innerHTML = '<div style="padding:24px;color:var(--fg-muted);">No graph data was generated.</div>';
    return;
  }

  graphState.filter = filter;
  const graph = visibleGraph(filter, graphState.search);
  graphState.nodes = layoutCanvasGraph(graph.nodes, graph.edges);
  graphState.edges = graph.edges;
  graphState.selectedId = graphState.nodes[0]?.id || null;
  graphState.hoveredId = null;
  fitGraphToView();
  bindCanvasEvents();
  drawGraph();
  updateGraphDetail();
}

function canvasPoint(clientX, clientY) {
  const canvas = document.getElementById('graph-canvas');
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function worldToScreen(n) {
  const canvas = document.getElementById('graph-canvas');
  return {
    x: canvas.width / devicePixelRatio / 2 + graphState.offsetX + n.x * graphState.scale,
    y: canvas.height / devicePixelRatio / 2 + graphState.offsetY + n.y * graphState.scale,
  };
}

function screenToWorld(p) {
  const canvas = document.getElementById('graph-canvas');
  return {
    x: (p.x - canvas.width / devicePixelRatio / 2 - graphState.offsetX) / graphState.scale,
    y: (p.y - canvas.height / devicePixelRatio / 2 - graphState.offsetY) / graphState.scale,
  };
}

function findNodeAt(p) {
  for (let i = graphState.nodes.length - 1; i >= 0; i--) {
    const n = graphState.nodes[i];
    const s = worldToScreen(n);
    const r = Math.max(9, n.size * graphState.scale + 5);
    const dx = p.x - s.x, dy = p.y - s.y;
    if (dx * dx + dy * dy <= r * r) return n;
  }
  return null;
}

function fitGraphToView() {
  const canvas = document.getElementById('graph-canvas');
  const host = document.getElementById('graph-host');
  const dpr = window.devicePixelRatio || 1;
  const rect = host.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width * dpr));
  canvas.height = Math.max(320, Math.floor(rect.height * dpr));
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  if (graphState.nodes.length === 0) return;
  const xs = graphState.nodes.map((n) => n.x);
  const ys = graphState.nodes.map((n) => n.y);
  const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs));
  const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
  graphState.scale = Math.min((rect.width - 80) / spanX, (rect.height - 80) / spanY, 1.7);
  graphState.offsetX = 0;
  graphState.offsetY = 0;
}

function bindCanvasEvents() {
  const canvas = document.getElementById('graph-canvas');
  if (canvas.dataset.bound === 'true') return;
  canvas.dataset.bound = 'true';

  canvas.addEventListener('mousedown', (e) => {
    const p = canvasPoint(e.clientX, e.clientY);
    const node = findNodeAt(p);
    graphState.dragging = true;
    graphState.dragNodeId = node?.id || null;
    graphState.lastX = p.x;
    graphState.lastY = p.y;
    if (node) {
      graphState.selectedId = node.id;
      updateGraphDetail();
      drawGraph();
    }
    canvas.classList.add('dragging');
  });
  window.addEventListener('mouseup', () => {
    graphState.dragging = false;
    graphState.dragNodeId = null;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('mousemove', (e) => {
    const p = canvasPoint(e.clientX, e.clientY);
    if (graphState.dragging) {
      const dx = p.x - graphState.lastX;
      const dy = p.y - graphState.lastY;
      if (graphState.dragNodeId) {
        const node = graphState.nodes.find((n) => n.id === graphState.dragNodeId);
        if (node) {
          node.x += dx / graphState.scale;
          node.y += dy / graphState.scale;
        }
      } else {
        graphState.offsetX += dx;
        graphState.offsetY += dy;
      }
      graphState.lastX = p.x;
      graphState.lastY = p.y;
      drawGraph();
      return;
    }
    const node = findNodeAt(p);
    const id = node?.id || null;
    if (id !== graphState.hoveredId) {
      graphState.hoveredId = id;
      drawGraph();
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = canvasPoint(e.clientX, e.clientY);
    const before = screenToWorld(p);
    const factor = e.deltaY < 0 ? 1.12 : 0.88;
    graphState.scale = Math.max(0.22, Math.min(4, graphState.scale * factor));
    const after = worldToScreen(before);
    graphState.offsetX += p.x - after.x;
    graphState.offsetY += p.y - after.y;
    drawGraph();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    fitGraphToView();
    drawGraph();
  });
  window.addEventListener('resize', () => {
    if (currentRoute === 'graph') {
      fitGraphToView();
      drawGraph();
    }
  });
}

function connectedToActive(edge) {
  const active = graphState.hoveredId || graphState.selectedId;
  return active && (edge.source === active || edge.target === active);
}

// Theme-reactive: read colors from the active CSS theme so the canvas
// matches the rest of the dashboard in both light and dark mode.
function readThemePalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    isDark,
    bg:           v('--graph-bg',           isDark ? '#05070d' : '#f8fafc'),
    grid:         v('--graph-grid',         isDark ? 'rgba(99,118,160,.10)' : 'rgba(15,23,42,.06)'),
    accent:       v('--graph-accent',       isDark ? '#22d3ee' : '#3b6cf6'),
    accentSoft:   v('--graph-accent-soft',  isDark ? 'rgba(34,211,238,.14)' : 'rgba(59,108,246,.16)'),
    edgeDefault:  v('--graph-edge-default', isDark ? 'rgba(96,165,250,.20)' : 'rgba(71,85,105,.30)'),
    edgeTarget:   v('--graph-edge-target',  isDark ? 'rgba(74,222,128,.28)' : 'rgba(22,163,74,.34)'),
    edgePackage:  v('--graph-edge-package', isDark ? 'rgba(192,132,252,.26)' : 'rgba(124,58,237,.32)'),
    edgeActive:   v('--graph-edge-active',  isDark ? 'rgba(34,211,238,.95)' : 'rgba(59,108,246,.95)'),
    labelBg:      v('--graph-label-bg',     isDark ? 'rgba(6,10,18,.88)' : '#ffffff'),
    labelFg:      v('--graph-label-fg',     isDark ? '#f1f5ff' : '#1a1d27'),
    labelBorder:  v('--graph-label-border', isDark ? 'rgba(34,211,238,.42)' : 'rgba(15,23,42,.18)'),
    nodeRing:     isDark ? 'rgba(255,255,255,.6)' : 'rgba(15,23,42,.42)',
  };
}

function drawGraph() {
  const canvas = document.getElementById('graph-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const palette = readThemePalette();

  // Base background — flat color in light mode, subtle radial gradient in dark.
  if (palette.isDark) {
    const gradient = ctx.createRadialGradient(width * 0.5, height * 0.45, 20, width * 0.5, height * 0.45, Math.max(width, height));
    gradient.addColorStop(0, '#111827');
    gradient.addColorStop(0.45, '#080c16');
    gradient.addColorStop(1, '#05070d');
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = palette.bg;
  }
  ctx.fillRect(0, 0, width, height);

  // Subtle grid that respects the theme.
  ctx.save();
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  for (let x = (graphState.offsetX % 44); x < width; x += 44) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = (graphState.offsetY % 44); y < height; y += 44) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  ctx.restore();

  // Edges, color-coded by relationship type and stronger when connected to
  // the hovered/selected node.
  const nodeById = new Map(graphState.nodes.map((n) => [n.id, n]));
  for (const e of graphState.edges) {
    const a = nodeById.get(e.source), b = nodeById.get(e.target);
    if (!a || !b) continue;
    const pa = worldToScreen(a), pb = worldToScreen(b);
    const active = connectedToActive(e);
    const edgeKind = String(e.type || e.label || '').toLowerCase();
    const isTarget = edgeKind.includes('target') || edgeKind.includes('role');
    const isPackage = edgeKind.includes('package');
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2 - 18;
    ctx.quadraticCurveTo(mx, my, pb.x, pb.y);
    ctx.strokeStyle = active
      ? palette.edgeActive
      : isTarget
        ? palette.edgeTarget
        : isPackage
          ? palette.edgePackage
          : palette.edgeDefault;
    ctx.lineWidth = active ? 2.1 : 1;
    if (isTarget && !active) ctx.setLineDash([6, 7]);
    else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Nodes — soft glow on hover/select, theme-aware ring, label pill.
  for (const n of graphState.nodes) {
    const p = worldToScreen(n);
    const selected = n.id === graphState.selectedId;
    const hovered = n.id === graphState.hoveredId;
    const radius = Math.max(5, n.size * graphState.scale);

    ctx.save();
    ctx.shadowColor = n.color;
    ctx.shadowBlur = selected || hovered ? (palette.isDark ? 26 : 18) : (palette.isDark ? 9 : 5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius + (selected ? 3 : 0), 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.globalAlpha = selected || hovered ? 1 : 0.85;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = selected ? palette.nodeRing : palette.accentSoft;
    ctx.lineWidth = selected ? 2.5 : 1;
    ctx.stroke();
    ctx.restore();

    const shouldLabel = selected || hovered || n.type === 'component' || graphState.scale > 1.1;
    if (shouldLabel) {
      const label = String(n.label || n.id);
      ctx.font = selected ? '600 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' : '500 11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
      const text = label.length > 34 ? label.slice(0, 31) + '…' : label;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = palette.labelBg;
      roundRect(ctx, p.x - tw / 2 - 8, p.y + radius + 7, tw + 16, 22, 5);
      ctx.fill();
      ctx.strokeStyle = selected || hovered ? palette.accent : palette.labelBorder;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = palette.labelFg;
      ctx.fillText(text, p.x - tw / 2, p.y + radius + 22);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function updateGraphDetail() {
  const detail = document.getElementById('graph-detail');
  if (!detail) return;
  const node = graphState.nodes.find((n) => n.id === graphState.selectedId);
  if (!node) {
    detail.innerHTML = '<h2>Graph</h2><p class="muted">Select a node to inspect it.</p>';
    return;
  }
  const incoming = graphState.edges.filter((e) => e.target === node.id);
  const outgoing = graphState.edges.filter((e) => e.source === node.id);
  const component = data.components.find((c) => c.name === node.label);
  const dot = nodeColor(node);
  detail.innerHTML = [
    '<div class="inspector-kicker">Node inspector</div>',
    '<h2>' + escapeText(node.label || node.id) + '</h2>',
    '<div class="node-type-pill" style="--node-dot:' + escapeText(dot) + '">' + escapeText(node.type || 'unknown') + '</div>',
    '<div class="kv">',
    '<span>Incoming</span><strong>' + incoming.length + '</strong>',
    '<span>Outgoing</span><strong>' + outgoing.length + '</strong>',
    component ? '<span>Gate</span><strong><span class="verdict ' + component.verdict + '">' + component.verdict.replace('_', ' ') + '</span></strong>' : '',
    component ? '<span>Role</span><strong>' + escapeText(component.targetRole) + '</strong>' : '',
    component ? '<span>Claims</span><strong>' + component.verifiedClaims + '/' + component.totalClaims + ' verified</strong>' : '',
    component ? '<span>Questions</span><strong>' + component.humanQuestions + '</strong>' : '',
    '</div>',
    '<h3>Connected edges</h3>',
    '<ul>' + [...incoming, ...outgoing].slice(0, 14).map((e) => '<li><code>' + escapeText(e.type || e.label || 'edge') + '</code> ' + escapeText(e.source) + ' → ' + escapeText(e.target) + '</li>').join('') + '</ul>',
    component ? '<p><a href="#component:' + encodeURIComponent(component.name) + '">Open component report</a></p>' : '',
  ].join('');
}

function bindGraphToolbar() {
  const toolbar = document.getElementById('graph-toolbar');
  const search = document.getElementById('graph-search');
  if (search && search.dataset.bound !== 'true') {
    search.dataset.bound = 'true';
    search.addEventListener('input', () => {
      graphState.search = search.value || '';
      buildGraph(graphState.filter);
    });
  }
  if (toolbar) {
    toolbar.querySelectorAll('.chip').forEach((chip) => {
      if (chip.dataset.bound === 'true') return;
      chip.dataset.bound = 'true';
      chip.addEventListener('click', () => {
        toolbar.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        buildGraph(chip.dataset.filter);
      });
    });
  }
  document.querySelectorAll('[data-graph-action]').forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      const action = button.dataset.graphAction;
      if (action === 'zoom-in') graphState.scale = Math.min(4, graphState.scale * 1.2);
      else if (action === 'zoom-out') graphState.scale = Math.max(0.22, graphState.scale * 0.82);
      else fitGraphToView();
      drawGraph();
    });
  });
}

// ----- Mermaid diagram rendering -------------------------------------------
// We render the generated system-graph.mmd ourselves instead of loading Mermaid
// from a CDN. This keeps dashboard.html fully self-contained for restricted
// company environments while still giving users a visual diagram.
function cleanMermaidLabel(value) {
  return String(value || '')
    .replace(/^component_/, '')
    .replace(/^target_role_/, '')
    .replace(/^source_package_/, '')
    .replace(/^target_package_/, '')
    .replace(/^source_file_/, '')
    .replace(/_/g, ' ');
}

function extractMermaidLabel(body, fallback) {
  const quoted = String(body || '').match(/"([^"]+)"/);
  if (quoted) return quoted[1];
  const cleaned = String(body || '').replace(/[\\[\\]\\(\\)"]/g, '').trim();
  return cleaned || cleanMermaidLabel(fallback);
}

function mermaidNodeType(id) {
  if (String(id).startsWith('target_role_')) return 'target_role';
  if (String(id).startsWith('source_package_')) return 'source_package';
  if (String(id).startsWith('target_package_')) return 'target_package';
  if (String(id).startsWith('source_file_')) return 'source_file';
  if (String(id).startsWith('component_')) return 'component';
  return 'component';
}

function parseMermaidGraph(source) {
  const nodes = new Map();
  const edges = [];
  const ensureNode = (id, label) => {
    if (!id) return;
    const existing = nodes.get(id);
    if (existing) {
      if (label && existing.label === cleanMermaidLabel(id)) existing.label = label;
      return;
    }
    nodes.set(id, { id, label: label || cleanMermaidLabel(id), type: mermaidNodeType(id) });
  };

  const lines = String(source || '').replace(/\\r\\n/g, '\\n').split('\\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%') || /^flowchart\\s+/i.test(line) || /^graph\\s+/i.test(line)) continue;

    const edgeMatch = line.match(/^([A-Za-z0-9_:-]+)\\s*(-\\.->|-->|---|-.->)\\s*(?:\\|([^|]+)\\|)?\\s*([A-Za-z0-9_:-]+)/);
    if (edgeMatch) {
      const sourceId = edgeMatch[1];
      const targetId = edgeMatch[4];
      ensureNode(sourceId);
      ensureNode(targetId);
      edges.push({
        source: sourceId,
        target: targetId,
        label: (edgeMatch[3] || '').trim(),
        dotted: edgeMatch[2].includes('.'),
      });
      continue;
    }

    const nodeMatch = line.match(/^([A-Za-z0-9_:-]+)\\s*(.+)$/);
    if (nodeMatch && /^[\\[\\(]/.test(nodeMatch[2].trim())) {
      ensureNode(nodeMatch[1], extractMermaidLabel(nodeMatch[2], nodeMatch[1]));
    }
  }

  return { nodes: Array.from(nodes.values()), edges };
}

function mermaidNodeStyle(node) {
  const component = node.type === 'component'
    ? data.components.find((c) => c.name === node.label || ('component_' + c.name) === node.id)
    : null;
  if (component?.verdict === 'ready') return { fill: '#e6f5ec', stroke: '#1b8a3a' };
  if (component?.verdict === 'needs_review') return { fill: '#fdf2dc', stroke: '#b35c00' };
  if (component?.verdict === 'blocked') return { fill: '#fce8e6', stroke: '#b3251f' };
  if (node.type === 'target_role') return { fill: '#e7f8ee', stroke: '#2b9b58' };
  if (node.type === 'source_package') return { fill: '#f3e8ff', stroke: '#8b5cf6' };
  if (node.type === 'target_package') return { fill: '#fff3d6', stroke: '#d97706' };
  if (node.type === 'source_file') return { fill: '#eef2f7', stroke: '#64748b' };
  return { fill: '#eaf0ff', stroke: '#3b6cf6' };
}

function layoutMermaidGraph(parsed) {
  const byId = new Map(parsed.nodes.map((node) => [node.id, node]));
  const layer = new Map();
  for (const node of parsed.nodes) {
    if (node.type === 'source_file' || node.type === 'source_package') layer.set(node.id, 0);
    else if (node.type === 'target_role' || node.type === 'target_package') layer.set(node.id, 2);
    else layer.set(node.id, 1);
  }

  for (let i = 0; i < parsed.nodes.length; i++) {
    let changed = false;
    for (const edge of parsed.edges) {
      if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
      const nextLayer = Math.min(4, (layer.get(edge.source) || 0) + 1);
      if ((layer.get(edge.target) || 0) < nextLayer) {
        layer.set(edge.target, nextLayer);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map();
  for (const node of parsed.nodes) {
    const l = layer.get(node.id) || 0;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(node);
  }
  const layers = Array.from(groups.keys()).sort((a, b) => a - b);
  for (const l of layers) {
    groups.get(l).sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  const xGap = 250;
  const yGap = 86;
  const marginX = 90;
  const marginY = 58;
  const maxRows = Math.max(1, ...Array.from(groups.values()).map((g) => g.length));
  const width = Math.max(760, marginX * 2 + Math.max(1, layers.length - 1) * xGap + 180);
  const height = Math.max(320, marginY * 2 + maxRows * yGap);
  const positioned = new Map();
  layers.forEach((l, layerIndex) => {
    const group = groups.get(l) || [];
    const totalHeight = (group.length - 1) * yGap;
    const startY = height / 2 - totalHeight / 2;
    group.forEach((node, rowIndex) => {
      const label = String(node.label || node.id);
      positioned.set(node.id, {
        ...node,
        x: marginX + layerIndex * xGap,
        y: startY + rowIndex * yGap,
        width: Math.max(132, Math.min(210, label.length * 8 + 34)),
        height: 42,
      });
    });
  });

  return { nodes: Array.from(positioned.values()), edges: parsed.edges, byId: positioned, width, height };
}

function renderMermaidDiagram() {
  const host = document.getElementById('mermaid-render');
  if (!host) return;
  const parsed = parseMermaidGraph(data.docs.systemGraphMermaid || '');
  if (!parsed.nodes.length) {
    host.innerHTML = '<div class="empty">No Mermaid graph was generated for this run.</div>';
    return;
  }

  const graph = layoutMermaidGraph(parsed);
  const defs = [
    '<defs>',
    '<marker id="mermaid-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">',
    '<path d="M0,0 L0,6 L9,3 z" fill="#94a3b8"></path>',
    '</marker>',
    '</defs>',
  ].join('');

  const edges = graph.edges.map((edge, index) => {
    const a = graph.byId.get(edge.source);
    const b = graph.byId.get(edge.target);
    if (!a || !b) return '';
    const startX = a.x + a.width / 2;
    const endX = b.x - b.width / 2;
    const c1x = startX + Math.max(38, (endX - startX) * 0.45);
    const c2x = endX - Math.max(38, (endX - startX) * 0.45);
    const path = 'M ' + startX + ' ' + a.y + ' C ' + c1x + ' ' + a.y + ', ' + c2x + ' ' + b.y + ', ' + endX + ' ' + b.y;
    const midX = (startX + endX) / 2;
    const midY = (a.y + b.y) / 2 - 8 - (index % 2) * 10;
    return [
      '<path class="mermaid-edge ' + (edge.dotted ? 'dotted' : '') + '" d="' + path + '" marker-end="url(#mermaid-arrow)"></path>',
      edge.label ? '<text class="mermaid-label" x="' + midX + '" y="' + midY + '" text-anchor="middle">' + escapeText(edge.label) + '</text>' : '',
    ].join('');
  }).join('');

  const nodes = graph.nodes.map((node) => {
    const style = mermaidNodeStyle(node);
    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;
    const label = String(node.label || node.id);
    const shortLabel = label.length > 28 ? label.slice(0, 25) + '…' : label;
    return [
      '<g class="mermaid-node">',
      '<rect x="' + x + '" y="' + y + '" width="' + node.width + '" height="' + node.height + '" rx="9" fill="' + style.fill + '" stroke="' + style.stroke + '"></rect>',
      '<text x="' + node.x + '" y="' + (node.y + 4) + '" text-anchor="middle">' + escapeText(shortLabel) + '</text>',
      '</g>',
    ].join('');
  }).join('');

  host.innerHTML = '<svg viewBox="0 0 ' + graph.width + ' ' + graph.height + '" role="img" aria-label="Rendered Mermaid system graph">' + defs + edges + nodes + '</svg>';
}

// ----- Route table -----------------------------------------------------------
function renderRoute() {
  if (!main) return;
  const route = currentRoute;

  if (route === 'overview')         main.innerHTML = renderOverview();
  else if (route === 'trust')       main.innerHTML = renderTrustGate();
  else if (route === 'components')  main.innerHTML = renderComponents();
  else if (route.startsWith('component:')) main.innerHTML = renderComponent(decodeURIComponent(route.slice('component:'.length)));
  else if (route === 'graph')       main.innerHTML = renderGraph();
  else if (route === 'reverse')     main.innerHTML = renderReverse();
  else if (route === 'architecture') main.innerHTML = renderArchitecture();
  else if (route === 'human')       main.innerHTML = renderHumanQuestions();
  else if (route === 'agents')      main.innerHTML = renderAgents();
  else if (route === 'validation')  main.innerHTML = renderValidationRisk();
  else if (route === 'contract')    main.innerHTML = renderRaw();
  else                              main.innerHTML = renderOverview();

  if (route === 'graph') {
    bindGraphToolbar();
    setTimeout(() => {
      buildGraph('all');
      renderMermaidDiagram();
    }, 50);
  }
}

renderRoute();
`;

function buildHtml(data: DashboardData): string {
  const navItems: Array<{ id: string; label: string; badge?: string }> = [
    { id: "overview",     label: "Overview" },
    { id: "trust",        label: "Trust gate", badge: `${data.meta.posture.needsReview + data.meta.posture.blocked}` },
    { id: "components",   label: "Components", badge: `${data.components.length}` },
    { id: "graph",        label: "System graph" },
    { id: "reverse",      label: "Reverse engineering" },
    { id: "architecture", label: "Architecture" },
    { id: "human",        label: "Human questions", badge: `${data.components.reduce((n, c) => n + c.humanQuestions, 0)}` },
    { id: "validation",   label: "Validation & risk" },
    { id: "agents",       label: "Agent handoff" },
    { id: "contract",     label: "Migration contract" },
  ];

  const nav = navItems.map((item) =>
    `<a data-route="${item.id}" href="#${item.id}">
       <span>${escapeHtml(item.label)}</span>
       ${item.badge && item.badge !== "0" ? `<span class="badge">${escapeHtml(item.badge)}</span>` : ""}
     </a>`
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(data.meta.repoLabel)} — CCS Migration</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-head">
      <h1>CCS Migration</h1>
      <div class="repo">${escapeHtml(data.meta.repoLabel)}</div>
      <div class="meta">${escapeHtml(data.meta.framework.sourceFramework)} → ${escapeHtml(data.meta.framework.targetFramework)}</div>
    </div>
    <nav class="nav">
      <div class="nav-section">Sections</div>
      ${nav}
    </nav>
    <div class="sidebar-foot">
      <button id="theme-toggle" class="theme-toggle" type="button">☾ Dark</button>
      <span style="margin-left:auto;">CCS Code</span>
    </div>
  </aside>
  <main class="main" id="main"></main>
</div>
${jsonScript("ccs-data", data)}
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type DashboardWriteResult = { dashboardPath: string };

export async function writeDashboard(input: DashboardInput): Promise<DashboardWriteResult> {
  const data = await gatherData(input);
  const html = buildHtml(data);
  const dashboardPath = join(input.layout.runDir, "dashboard.html");
  await fs.writeFile(dashboardPath, html, "utf-8");
  return { dashboardPath };
}

/**
 * Regenerate dashboard.html for an existing run folder from files on disk.
 * This is intentionally tolerant so `/migrate dashboard <run>` works even when
 * the original in-memory analyses are not available anymore.
 */
export async function writeDashboardFromRunDir(runDir: string): Promise<DashboardWriteResult> {
  const contract = await readOptionalJson(join(runDir, "migration-contract.json")) as any;
  if (!contract) {
    throw new Error(`No migration-contract.json found in ${runDir}`);
  }

  const components = (contract.components ?? []).map((component: any) => ({
    name: component.name ?? "unknown",
    type: component.type ?? "unknown",
    targetRole: component.target?.role ?? "unknown",
    complexity: component.risk?.complexity ?? "unknown",
    confidence: component.risk?.confidence ?? "unknown",
    verdict: component.implementationStatus ?? component.verification?.trustVerdict ?? "no_verification",
    verifiedClaims: component.verification?.totals?.verified ?? 0,
    totalClaims: component.verification?.totals?.claimsChecked ?? 0,
    humanQuestions: component.humanQuestions?.length ?? 0,
    dependencies: component.dependencies ?? [],
    doc: "",
  })) as ComponentEntry[];

  for (const component of components) {
    component.doc = await readOptionalText(join(runDir, "components", `${component.name}.md`));
  }

  const archEntries = await readDirOptional(join(runDir, "architecture-context"));
  const architectureContextFiles: Array<{ name: string; content: string }> = [];
  for (const name of archEntries) {
    const content = await readOptionalText(join(runDir, "architecture-context", name));
    if (content) architectureContextFiles.push({ name, content });
  }

  const ready       = components.filter((c) => c.verdict === "ready").length;
  const needsReview = components.filter((c) => c.verdict === "needs_review").length;
  const blocked     = components.filter((c) => c.verdict === "blocked").length;
  const migration = contract.migration ?? {};
  const data: DashboardData = {
    meta: {
      repo: contract.repoUrl ?? basename(runDir),
      repoLabel: (contract.repoUrl ?? basename(runDir)).split("/").slice(-2).join("/"),
      generatedAt: contract.generatedAt ?? new Date().toISOString(),
      framework: {
        sourceFramework: migration.sourceFramework ?? "unknown",
        sourceLanguage: migration.sourceLanguage ?? "unknown",
        targetFramework: migration.targetFramework ?? "unknown",
        targetLanguage: migration.targetLanguage ?? "unknown",
        architecturePattern: migration.architecturePattern ?? "unknown",
      },
      posture: { ready, needsReview, blocked },
      pipelineErrors: [],
      migrationOrder: contract.migrationOrder ?? components.map((c) => c.name),
    },
    docs: {
      readme:                     await readOptionalText(join(runDir, "README.md")),
      agents:                     await readOptionalText(join(runDir, "AGENTS.md")),
      architectureBaseline:       await readOptionalText(join(runDir, "architecture-baseline.md")),
      preflightReadiness:         await readOptionalText(join(runDir, "preflight-readiness.md")),
      componentDispositionMatrix: await readOptionalText(join(runDir, "component-disposition-matrix.md")),
      humanQuestions:             await readOptionalText(join(runDir, "human-questions.md")),
      verificationSummary:        await readOptionalText(join(runDir, "verification-summary.md")),
      dependencyRiskReport:       await readOptionalText(join(runDir, "dependency-risk-report.md")),
      testScaffoldsIndex:         await readOptionalText(join(runDir, "test-scaffolds", "README.md")),
      reverseEngineeringDetails:  await readOptionalText(join(runDir, "reverse-engineering", "reverse-engineering-details.md")),
      systemGraphMermaid:         await readOptionalText(join(runDir, "system-graph.mmd")),
    },
    components,
    graph: await readOptionalJson(join(runDir, "system-graph.json")),
    businessLogic: await readOptionalJson(join(runDir, "reverse-engineering", "business-logic.json")),
    architectureContextFiles,
    contractJson: contract,
  };

  const dashboardPath = join(runDir, "dashboard.html");
  await fs.writeFile(dashboardPath, buildHtml(data), "utf-8");
  return { dashboardPath };
}

/** Path helper for the CLI — used by /migrate dashboard. */
export function dashboardPathFor(runDir: string): string {
  return join(runDir, "dashboard.html");
}

/** Used by the CLI to display the file with a human-friendly label. */
export function dashboardLabelFor(runDir: string): string {
  return basename(runDir);
}
