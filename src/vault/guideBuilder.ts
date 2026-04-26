import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";

export async function generateGuideHtml(): Promise<string> {
  const outputPath = join(homedir(), ".ccs", "guide.html");
  await fs.mkdir(join(homedir(), ".ccs"), { recursive: true });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CCS Code — How to Use</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d0f14;
    --card: #13161d;
    --border: rgba(255,255,255,0.07);
    --text: #e2e8f0;
    --muted: #64748b;
    --faint: #334155;
    --indigo: #818cf8;
    --blue: #38bdf8;
    --green: #4ade80;
    --orange: #fb923c;
    --violet: #a78bfa;
    --amber: #fbbf24;
    --teal: #2dd4bf;
    --pink: #f472b6;
  }
  html { font-size: 15px; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    line-height: 1.7;
    padding: 0 0 80px;
  }

  /* ── Hero ── */
  .hero {
    text-align: center;
    padding: 56px 24px 40px;
    border-bottom: 1px solid var(--border);
  }
  .hero-badge {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(129,140,248,0.1);
    border: 1px solid rgba(129,140,248,0.25);
    border-radius: 100px; padding: 5px 14px;
    font-size: 11px; font-weight: 600; letter-spacing: 1.5px;
    color: var(--indigo); margin-bottom: 20px;
  }
  .hero h1 { font-size: 38px; font-weight: 800; letter-spacing: -1px; margin-bottom: 12px; }
  .hero p { font-size: 17px; color: var(--muted); max-width: 520px; margin: 0 auto 28px; }
  .hero-cmd {
    display: inline-block;
    background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding: 10px 24px;
    font-family: 'JetBrains Mono','Fira Code','Courier New',monospace;
    font-size: 15px; color: var(--green);
  }

  /* ── Layout ── */
  .container { max-width: 900px; margin: 0 auto; padding: 0 24px; }

  /* ── Section ── */
  .section { margin-top: 56px; }
  .section-label {
    font-size: 11px; letter-spacing: 2.5px; font-weight: 700;
    color: var(--muted); text-transform: uppercase; margin-bottom: 16px;
  }
  .section h2 {
    font-size: 24px; font-weight: 700; margin-bottom: 8px;
  }
  .section > p { color: var(--muted); font-size: 14px; margin-bottom: 24px; }

  /* ── Cards ── */
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px;
    margin-bottom: 16px;
  }
  .card-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;
  }
  .card-sm {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px;
  }
  .card-sm .icon { font-size: 22px; margin-bottom: 8px; }
  .card-sm h4 { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
  .card-sm p { font-size: 12px; color: var(--muted); line-height: 1.5; }

  /* ── Step list ── */
  .steps { display: flex; flex-direction: column; gap: 0; }
  .step {
    display: flex; gap: 20px;
    padding-bottom: 32px;
    position: relative;
  }
  .step:not(:last-child)::before {
    content: "";
    position: absolute; left: 19px; top: 42px;
    width: 2px; bottom: 0;
    background: linear-gradient(to bottom, var(--faint), transparent);
  }
  .step-num {
    width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 700;
    border: 1px solid;
  }
  .step-body { flex: 1; }
  .step-body h3 { font-size: 16px; font-weight: 700; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
  .step-body p { font-size: 13px; color: var(--muted); margin-bottom: 12px; line-height: 1.7; }
  .cmd-tag {
    display: inline-block; font-family: monospace; font-size: 13px;
    padding: 2px 10px; border-radius: 5px; margin-right: 6px;
    font-weight: 700;
  }

  /* ── Code block ── */
  .codeblock {
    background: #060810; border: 1px solid var(--border);
    border-radius: 8px; padding: 14px 16px; margin-top: 10px;
    font-family: 'JetBrains Mono','Fira Code','Courier New',monospace;
    font-size: 13px; line-height: 1.8; overflow-x: auto;
  }
  .codeblock .prompt { color: var(--faint); }
  .codeblock .cmd    { color: var(--green); }
  .codeblock .out    { color: var(--muted); }
  .codeblock .good   { color: var(--teal); }

  /* ── Mermaid container ── */
  .mermaid-wrap {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 32px 24px;
    display: flex; justify-content: center; overflow-x: auto;
  }
  .mermaid { min-width: 300px; }

  /* ── Command table ── */
  .cmd-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .cmd-table th {
    text-align: left; padding: 10px 14px;
    font-size: 11px; letter-spacing: 1.5px; font-weight: 700;
    color: var(--muted); text-transform: uppercase;
    border-bottom: 1px solid var(--border);
  }
  .cmd-table td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .cmd-table tr:last-child td { border-bottom: none; }
  .cmd-table td:first-child { font-family: monospace; font-size: 13px; font-weight: 700; }
  .cmd-table td:last-child { color: var(--muted); }

  /* ── Provider pills ── */
  .providers { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .provider {
    display: flex; align-items: center; gap: 8px;
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 14px; font-size: 13px;
  }
  .provider-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

  /* ── Mermaid theme overrides ── */
  .mermaid svg { max-width: 100%; }
</style>
</head>
<body>

<!-- ── Hero ──────────────────────────────────────────────────────────────── -->
<div class="hero">
  <div class="hero-badge">INTERACTIVE GUIDE</div>
  <h1>How to use CCS Code</h1>
  <p>Sync knowledge from GitHub and files, build a wiki, visualize it, and ask questions — all from the terminal.</p>
  <div class="hero-cmd">ccs-code</div>
</div>

<div class="container">

<!-- ── What it does ───────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">Overview</div>
  <h2>What CCS Code does</h2>
  <p>CCS Code turns raw files and GitHub repos into a searchable, visual knowledge base. Run it once and you have a wiki. Run it again and it merges in the new content.</p>

  <div class="card-grid">
    <div class="card-sm">
      <div class="icon">⬇</div>
      <h4>Sync</h4>
      <p>Pull commits, PRs, issues, and READMEs from GitHub into a local inbox.</p>
    </div>
    <div class="card-sm">
      <div class="icon">📄</div>
      <h4>Build wiki</h4>
      <p>Convert raw files into cross-linked Markdown wiki pages. Merges automatically on re-run.</p>
    </div>
    <div class="card-sm">
      <div class="icon">✦</div>
      <h4>AI enrich</h4>
      <p>AI adds a summary, tags, and links to related pages for each wiki page.</p>
    </div>
    <div class="card-sm">
      <div class="icon">◉</div>
      <h4>Graph</h4>
      <p>An interactive visual map of your entire knowledge base — clusters by topic.</p>
    </div>
    <div class="card-sm">
      <div class="icon">🔍</div>
      <h4>Ask</h4>
      <p>Ask any question. CCS Code finds relevant pages and answers from your wiki.</p>
    </div>
    <div class="card-sm">
      <div class="icon">🤖</div>
      <h4>Any AI tool</h4>
      <p>Your wiki is plain Markdown. Works with Claude Code, Copilot, Cursor, and any agent.</p>
    </div>
  </div>
</div>

<!-- ── Pipeline diagram ───────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">Pipeline</div>
  <h2>The 6-step pipeline</h2>
  <p>Run commands in this order the first time. After that, re-run any step when you have new content.</p>

  <div class="mermaid-wrap">
    <div class="mermaid">
flowchart TD
    A([▶ Start: ccs-code]) --> B

    B["/vault init\ncreate knowledge base"]
    B --> C

    C{How are you\nadding content?}
    C -->|GitHub repos| D
    C -->|Local files| E

    D["/sync\npull commits · PRs · issues"]
    E["Drop files into\nraw/uploads/"]

    D --> F
    E --> F

    F["/ingest\nbuild wiki pages from raw/"]
    F --> G

    G["/enrich\nAI summaries + wikilinks"]
    G --> H

    H{What do you\nwant to do?}
    H -->|Explore visually| I
    H -->|Ask a question| J
    H -->|Keep it updated| K

    I["/graph\ninteractive browser graph"]
    J["/ask your question\nanswered from your wiki"]
    K["Re-run /sync + /ingest\nwhen content changes"]

    I --> L([✓ Done])
    J --> L
    K --> F

    style A fill:#1e293b,stroke:#4ade80,color:#4ade80
    style L fill:#1e293b,stroke:#4ade80,color:#4ade80
    style B fill:#1e1e2e,stroke:#818cf8,color:#818cf8
    style C fill:#1e1e2e,stroke:#64748b,color:#94a3b8
    style D fill:#1e1e2e,stroke:#38bdf8,color:#38bdf8
    style E fill:#1e1e2e,stroke:#38bdf8,color:#38bdf8
    style F fill:#1e1e2e,stroke:#fb923c,color:#fb923c
    style G fill:#1e1e2e,stroke:#a78bfa,color:#a78bfa
    style H fill:#1e1e2e,stroke:#64748b,color:#94a3b8
    style I fill:#1e1e2e,stroke:#4ade80,color:#4ade80
    style J fill:#1e1e2e,stroke:#fbbf24,color:#fbbf24
    style K fill:#1e1e2e,stroke:#2dd4bf,color:#2dd4bf
    </div>
  </div>
</div>

<!-- ── Step by step ───────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">Tutorial</div>
  <h2>Step by step</h2>
  <p>Follow these steps from a fresh install to a working knowledge base.</p>

  <div class="steps">

    <div class="step">
      <div class="step-num" style="background:rgba(129,140,248,0.1);border-color:rgba(129,140,248,0.4);color:#818cf8">1</div>
      <div class="step-body">
        <h3>
          <span class="cmd-tag" style="background:rgba(129,140,248,0.1);color:#818cf8">/vault init</span>
          Create your knowledge base
        </h3>
        <p>Creates the vault folder structure and saves it as your active vault. After running, you'll see the exact folder path where you should put your files, plus the accepted formats.</p>
        <div class="codeblock">
<span class="prompt">&gt; </span><span class="cmd">/vault init</span>
<span class="good">✓ Vault initialized at: /Users/you/vault</span>
<span class="out">  13 files created</span>
<span class="out"></span>
<span class="out">── Where to put your files ──────────────────────────</span>
<span class="good">  /Users/you/vault/raw/uploads</span>
<span class="out">  Drop any file here and run /ingest to process it.</span>
<span class="out"></span>
<span class="out">── Accepted formats ─────────────────────────────────</span>
<span class="out">  .md   .txt   .html   .json   .csv   .pdf</span>
<span class="out"></span>
<span class="out">── Next steps ───────────────────────────────────────</span>
<span class="out">  1. Copy your files into:  raw/uploads/</span>
<span class="out">  2. Run /ingest            convert files → wiki pages</span>
        </div>
      </div>
    </div>

    <div class="step">
      <div class="step-num" style="background:rgba(56,189,248,0.1);border-color:rgba(56,189,248,0.4);color:#38bdf8">2</div>
      <div class="step-body">
        <h3>
          <span class="cmd-tag" style="background:rgba(56,189,248,0.1);color:#38bdf8">/sync</span>
          Pull from GitHub  <span style="color:var(--muted);font-size:13px;font-weight:400">(or skip if using local files)</span>
        </h3>
        <p>Pulls commits, PRs, issues, and README from repos in your <code style="color:var(--indigo);background:rgba(129,140,248,0.1);padding:1px 5px;border-radius:3px">ccs.yaml</code>. If you're adding local files instead, drop them in <code style="color:var(--orange);background:rgba(251,146,60,0.1);padding:1px 5px;border-radius:3px">raw/uploads/</code> and skip to step 3.</p>
        <div class="codeblock">
<span class="out"># ccs.yaml — configure your repos first:</span>
<span class="out">sources:</span>
<span class="out">  - type: github</span>
<span class="out">    repos: [my-org/auth-svc, my-org/payment-svc]</span>
<span class="out">    token_env: GH_TOKEN</span>
<span class="out"></span>
<span class="prompt">&gt; </span><span class="cmd">/sync</span>
<span class="good">  ✓ github:my-org/auth-svc — 4 file(s) written</span>
<span class="good">  ✓ github:my-org/payment-svc — 4 file(s) written</span>
        </div>
      </div>
    </div>

    <div class="step">
      <div class="step-num" style="background:rgba(251,146,60,0.1);border-color:rgba(251,146,60,0.4);color:#fb923c">3</div>
      <div class="step-body">
        <h3>
          <span class="cmd-tag" style="background:rgba(251,146,60,0.1);color:#fb923c">/ingest</span>
          Build wiki pages
        </h3>
        <p>Reads everything in <code style="color:var(--orange);background:rgba(251,146,60,0.1);padding:1px 5px;border-radius:3px">raw/</code> and converts it to Markdown wiki pages in <code style="color:var(--violet);background:rgba(167,139,250,0.1);padding:1px 5px;border-radius:3px">wiki/</code>. Re-running merges new content in — existing pages are never deleted or overwritten.</p>
        <div class="codeblock">
<span class="prompt">&gt; </span><span class="cmd">/ingest</span>
<span class="good">✓ Created 8 new wiki page(s):</span>
<span class="out">  + wiki/concepts/auth-svc.md</span>
<span class="out">  + wiki/concepts/payment-svc.md</span>
<span class="out">  + wiki/conversations/react-hooks-2024.md</span>
<span class="out">  ... and 5 more</span>
<span class="good">↻ Merged new content into 2 existing page(s)</span>
<span class="out"></span>
<span class="out">Run /enrich to add AI summaries and links.</span>
        </div>
      </div>
    </div>

    <div class="step">
      <div class="step-num" style="background:rgba(167,139,250,0.1);border-color:rgba(167,139,250,0.4);color:#a78bfa">4</div>
      <div class="step-body">
        <h3>
          <span class="cmd-tag" style="background:rgba(167,139,250,0.1);color:#a78bfa">/enrich</span>
          Add AI summaries and links
        </h3>
        <p>Sends each wiki page to your configured AI provider. Gets back a summary, tags, and a list of related pages. Injects <code style="color:var(--indigo);background:rgba(129,140,248,0.1);padding:1px 5px;border-radius:3px">[[wikilinks]]</code> between related pages. Only runs on pages that don't have a summary yet, so it's safe to re-run.</p>
        <div class="codeblock">
<span class="prompt">&gt; </span><span class="cmd">/enrich</span>
<span class="out">Provider: anthropic/claude-sonnet-4-6</span>
<span class="out"></span>
<span class="good">✓ Enriched 8 page(s) with summaries, tags, and [[wikilinks]]</span>
<span class="out"></span>
<span class="out">Run /graph to rebuild the knowledge graph.</span>
        </div>
      </div>
    </div>

    <div class="step">
      <div class="step-num" style="background:rgba(74,222,128,0.1);border-color:rgba(74,222,128,0.4);color:#4ade80">5</div>
      <div class="step-body">
        <h3>
          <span class="cmd-tag" style="background:rgba(74,222,128,0.1);color:#4ade80">/graph</span>
          Open the visual graph
        </h3>
        <p>Builds an interactive vis.js graph of your entire wiki and opens it in your browser. Nodes are wiki pages, sized by how many connections they have. Colors indicate topic clusters. Click any node to see its summary.</p>
        <div class="codeblock">
<span class="prompt">&gt; </span><span class="cmd">/graph</span>
<span class="out">Vault: /Users/you/vault</span>
<span class="good">Graph built: 24 nodes, 41 edges</span>
<span class="out">Saved to: output/graph.html</span>
<span class="out"></span>
<span class="out">Opening in browser…</span>
        </div>
      </div>
    </div>

    <div class="step">
      <div class="step-num" style="background:rgba(251,191,36,0.1);border-color:rgba(251,191,36,0.4);color:#fbbf24">6</div>
      <div class="step-body">
        <h3>
          <span class="cmd-tag" style="background:rgba(251,191,36,0.1);color:#fbbf24">/ask</span>
          Ask your wiki anything
        </h3>
        <p>Searches your wiki for the most relevant pages and answers your question using that context. Every claim is cited with a <code style="color:var(--indigo);background:rgba(129,140,248,0.1);padding:1px 5px;border-radius:3px">[[page-name]]</code> so you can trace it back.</p>
        <div class="codeblock">
<span class="prompt">&gt; </span><span class="cmd">/ask what does auth-svc depend on?</span>
<span class="out"></span>
<span class="out">Searching wiki… found 3 relevant page(s)</span>
<span class="out"></span>
<span class="out">Based on the wiki:</span>
<span class="out"></span>
<span class="out">[[auth-svc]] depends on two services:</span>
<span class="out">1. [[user-svc]] — session token validation</span>
<span class="out">2. [[notification-svc]] — verification emails</span>
<span class="out"></span>
<span class="out">## Sources</span>
<span class="out">- auth-svc · dependency-map · architecture-decisions</span>
        </div>
      </div>
    </div>

  </div><!-- /steps -->
</div>

<!-- ── Decision diagram ───────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">Workflows</div>
  <h2>What do you want to do?</h2>
  <p>Not sure which command to run? Start from your goal.</p>

  <div class="mermaid-wrap">
    <div class="mermaid">
flowchart TD
    START([What do I want to do?])

    START --> Q1{I have\nnew files}
    START --> Q2{I want to\nexplore connections}
    START --> Q3{I want to\nask a question}
    START --> Q4{I want to\ncheck vault health}

    Q1 --> A1["Drop files in raw/uploads/\nor add GitHub repo to ccs.yaml"]
    A1 --> A2["/ingest → /enrich"]
    A2 --> A3["/graph or /ask"]

    Q2 --> B1{Wiki pages\nexist?}
    B1 -->|Yes, enriched| B2["/graph"]
    B1 -->|Yes, not enriched| B3["/enrich → /graph"]
    B1 -->|No| B4["/ingest → /enrich → /graph"]

    Q3 --> C1{Wiki pages\nexist?}
    C1 -->|Yes| C2["/ask your question"]
    C1 -->|No| C3["/ingest → /enrich → /ask"]

    Q4 --> D1["/vault status"]
    D1 --> D2["/index rebuild master index"]
    D2 --> D3["/lint check for broken links"]

    style START fill:#1e293b,stroke:#818cf8,color:#818cf8
    style A2 fill:#1e1e2e,stroke:#fb923c,color:#fb923c
    style A3 fill:#1e1e2e,stroke:#4ade80,color:#4ade80
    style B2 fill:#1e1e2e,stroke:#4ade80,color:#4ade80
    style B3 fill:#1e1e2e,stroke:#a78bfa,color:#a78bfa
    style B4 fill:#1e1e2e,stroke:#38bdf8,color:#38bdf8
    style C2 fill:#1e1e2e,stroke:#fbbf24,color:#fbbf24
    style C3 fill:#1e1e2e,stroke:#38bdf8,color:#38bdf8
    style D1 fill:#1e1e2e,stroke:#64748b,color:#94a3b8
    </div>
  </div>
</div>

<!-- ── Command reference ──────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">Reference</div>
  <h2>All commands</h2>

  <div class="card">
    <table class="cmd-table">
      <thead>
        <tr>
          <th>Command</th>
          <th>What it does</th>
          <th>When to use</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="color:#818cf8">/vault init [path]</td>
          <td>Create or open a vault</td>
          <td>First time setup</td>
        </tr>
        <tr>
          <td style="color:#818cf8">/vault status</td>
          <td>Show vault info and counts</td>
          <td>Check current state</td>
        </tr>
        <tr>
          <td style="color:#38bdf8">/sync</td>
          <td>Pull from GitHub repos in ccs.yaml</td>
          <td>Before /ingest when using GitHub sources</td>
        </tr>
        <tr>
          <td style="color:#fb923c">/ingest</td>
          <td>Convert raw/ files into wiki pages</td>
          <td>After adding new files to raw/</td>
        </tr>
        <tr>
          <td style="color:#a78bfa">/enrich</td>
          <td>AI summaries, tags, wikilinks</td>
          <td>After /ingest, before /graph</td>
        </tr>
        <tr>
          <td style="color:#4ade80">/graph</td>
          <td>Open interactive knowledge graph</td>
          <td>After /enrich to visualize connections</td>
        </tr>
        <tr>
          <td style="color:#fbbf24">/ask &lt;question&gt;</td>
          <td>Query your wiki in plain English</td>
          <td>Any time after /ingest</td>
        </tr>
        <tr>
          <td style="color:#2dd4bf">/index</td>
          <td>Rebuild master index</td>
          <td>After large wiki changes</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/lint</td>
          <td>Wiki health check</td>
          <td>Find orphans, broken links</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/clear</td>
          <td>Clear conversation history</td>
          <td>Fresh start</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/help</td>
          <td>Show keyboard shortcuts</td>
          <td>Any time</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/guide</td>
          <td>Open this guide</td>
          <td>Any time</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/setup</td>
          <td>Codex / Claude Code MCP setup snippets</td>
          <td>Wiring an agent to CCS</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>

<!-- ── Migration commands ─────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">Migration intelligence</div>
  <h2>Migration commands &amp; flags</h2>
  <p>Every <code style="background:rgba(56,189,248,0.1);color:#38bdf8;padding:1px 5px;border-radius:3px">/migrate</code> subcommand and the flags it accepts. Type <code>/m</code> in CCS to autocomplete the full menu.</p>

  <div class="card" style="overflow-x:auto;">
    <table class="cmd-table">
      <thead>
        <tr>
          <th>Subcommand</th>
          <th>Flags</th>
          <th>Purpose</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="color:#38bdf8">/migrate rewrite</td>
          <td><code>--repo &lt;url&gt;</code> · <code>--to &lt;lang&gt;</code> · <code>--from &lt;fw&gt;</code> · <code>--context &lt;path&gt;</code> (repeatable) · <code>--yes</code></td>
          <td>Full pipeline: scan → reverse-engineer → analyze → verify → contract</td>
        </tr>
        <tr>
          <td style="color:#38bdf8">/migrate reverse-eng</td>
          <td><code>--repo &lt;url&gt;</code> · <code>--to &lt;lang&gt;</code> · <code>--context &lt;path&gt;</code> · <code>--yes</code></td>
          <td>Just the reverse-engineering and graph artifacts (no agent contract)</td>
        </tr>
        <tr>
          <td style="color:#38bdf8">/migrate scan</td>
          <td><code>--repo &lt;url&gt;</code> · <code>--lang &lt;lang&gt;</code> · <code>--yes</code></td>
          <td>Scan external SOAP / service calls in a Node.js repo</td>
        </tr>
        <tr>
          <td style="color:#4ade80">/migrate open</td>
          <td><code>[&lt;slug&gt;]</code> · <code>--dashboard</code></td>
          <td>Open the latest run folder, or its dashboard.html</td>
        </tr>
        <tr>
          <td style="color:#4ade80">/migrate dashboard</td>
          <td><code>[&lt;slug&gt;]</code> · <code>--open</code></td>
          <td>Show or open the dashboard for a run</td>
        </tr>
        <tr>
          <td style="color:#fb923c">/migrate clean</td>
          <td><code>[&lt;slug&gt;]</code> · <code>--all</code> · <code>--yes</code></td>
          <td>Remove old run folders under your migration root</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/migrate status</td>
          <td>—</td>
          <td>Show migration progress table</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/migrate context</td>
          <td><code>&lt;ServiceName&gt;</code></td>
          <td>Print a single service context doc</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/migrate verify</td>
          <td><code>&lt;ServiceName&gt;</code></td>
          <td>Mark a service as verified</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/migrate db</td>
          <td><code>--service &lt;name&gt;</code> · <code>--yes</code></td>
          <td>Live database schema extraction (read-only, user-approved)</td>
        </tr>
        <tr>
          <td style="color:#94a3b8">/migrate plugin</td>
          <td>—</td>
          <td>List installed migration plugins</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card" style="margin-top: 16px;">
    <p style="margin:0 0 8px 0;font-weight:600;">Natural language also works.</p>
    <p style="margin:0;color:var(--muted);font-size:14px;">CCS detects migration intent in plain English. Typing <code style="background:rgba(56,189,248,0.1);color:#38bdf8;padding:1px 5px;border-radius:3px">migrate https://github.com/org/repo to csharp</code> auto-runs the rewrite pipeline. If the target language is missing, CCS asks for it once instead of dumping a re-run instruction.</p>
  </div>

  <div class="card" style="margin-top: 16px;">
    <p style="margin:0 0 8px 0;font-weight:600;">What lands in the run folder</p>
    <p style="margin:0 0 6px 0;color:var(--muted);font-size:14px;">Every run produces a single repo-scoped folder named after the slug. Inside:</p>
    <ul style="margin:6px 0 0 18px;color:var(--muted);font-size:14px;line-height:1.7;">
      <li><code style="color:var(--text)">README.md</code> — start here, table of contents</li>
      <li><code style="color:var(--text)">AGENTS.md</code> — entry point for Codex / Claude</li>
      <li><code style="color:var(--text)">migration-contract.json</code> — machine-readable contract (the source of truth)</li>
      <li><code style="color:var(--text)">verification-summary.md</code> — trust gate across all components</li>
      <li><code style="color:var(--text)">human-questions.md</code> — open architecture decisions</li>
      <li><code style="color:var(--text)">architecture-baseline.md</code>, <code style="color:var(--text)">preflight-readiness.md</code>, <code style="color:var(--text)">component-disposition-matrix.md</code></li>
      <li><code style="color:var(--text)">system-graph.json</code> + <code style="color:var(--text)">.mmd</code> — dependency graph</li>
      <li><code style="color:var(--text)">components/&lt;Name&gt;.md</code> — per-component context with verification inline</li>
      <li><code style="color:var(--text)">reverse-engineering/</code> — extracted business logic</li>
      <li><code style="color:var(--text)">architecture-context/</code> — copies of your <code>--context</code> docs</li>
      <li><code style="color:var(--text)">claude-commands/</code> — Claude Code slash commands per component</li>
      <li><code style="color:var(--text)">dashboard.html</code> — interactive viewer (light/dark)</li>
    </ul>
  </div>
</div>

<!-- ── Providers ──────────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">Configuration</div>
  <h2>AI providers</h2>
  <p>CCS Code uses your configured AI provider for <code style="color:var(--violet);background:rgba(167,139,250,0.1);padding:1px 5px;border-radius:3px">/enrich</code> and <code style="color:var(--amber);background:rgba(251,191,36,0.1);padding:1px 5px;border-radius:3px">/ask</code>. Set an env variable and add to ccs.yaml.</p>

  <div class="providers">
    <div class="provider">
      <div class="provider-dot" style="background:#0078d4"></div>
      <div>
        <div style="font-size:13px;font-weight:600">Enterprise Azure OpenAI</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">CCS_ENTERPRISE_CLIENT_ID + CCS_ENTERPRISE_CLIENT_SECRET</div>
      </div>
    </div>
    <div class="provider">
      <div class="provider-dot" style="background:#c2760c"></div>
      <div>
        <div style="font-size:13px;font-weight:600">Anthropic Claude</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">ANTHROPIC_API_KEY</div>
      </div>
    </div>
    <div class="provider">
      <div class="provider-dot" style="background:#16a34a"></div>
      <div>
        <div style="font-size:13px;font-weight:600">OpenAI</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">OPENAI_API_KEY</div>
      </div>
    </div>
  </div>

  <div class="codeblock" style="margin-top:16px">
<span class="out"># ccs.yaml</span>
<span class="out">llm:</span>
<span class="out">  provider: anthropic   # azure_openai | anthropic | openai</span>
<span class="out">  model: claude-sonnet-4-6</span>
  </div>
</div>

</div><!-- /container -->

<script>
  mermaid.initialize({
    startOnLoad: true,
    theme: 'dark',
    themeVariables: {
      background: '#13161d',
      primaryColor: '#1e293b',
      primaryTextColor: '#e2e8f0',
      primaryBorderColor: '#334155',
      lineColor: '#475569',
      secondaryColor: '#1e1e2e',
      tertiaryColor: '#0d0f14',
      edgeLabelBackground: '#13161d',
      clusterBkg: '#1e293b',
      titleColor: '#e2e8f0',
      nodeTextColor: '#e2e8f0',
    },
    flowchart: {
      curve: 'basis',
      padding: 20,
    },
  });
</script>
</body>
</html>`;

  await fs.writeFile(outputPath, html, "utf-8");
  return outputPath;
}
