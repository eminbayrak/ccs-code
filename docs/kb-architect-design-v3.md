# CCS Code — Architecture & Usage Guide

> A personal AI-powered knowledge base CLI. Syncs from GitHub, ingests local files, builds a cross-linked wiki, visualizes it as an interactive graph, and answers questions from your own knowledge.

---

## What it does

You run `ccs-code` in your terminal. You have a set of commands that form a pipeline. Each time you run through the pipeline, your knowledge base grows and compounds.

```
GitHub repos  +  local files  +  Claude conversations
        │
        ▼ /sync + drop into raw/
        │
        ▼ /ingest  →  wiki/ pages (Markdown, auto-merged)
        │
        ▼ /enrich  →  AI summaries + tags + [[wikilinks]]
        │
        ├── /graph  →  interactive vis.js graph in browser
        └── /ask    →  TF-IDF search → LLM answers with citations
```

---

## Commands

### `/vault init [path]`

Creates the vault folder structure. Saves the path as your active vault in `~/.ccs/config.json` — all other commands pick it up automatically.

```
> /vault init
✓ Vault initialized at: /Users/you/vault
  5 files created

> /vault init ~/my-knowledge-base
✓ Vault initialized at: /Users/you/my-knowledge-base
```

### `/vault status`

Shows the active vault and its current counts.

```
> /vault status
Vault: /Users/you/vault
  wiki pages  — 24
  raw files   — 3 ready to ingest
  skills      — 5
```

---

### `/sync`

Pulls the latest commits, PRs, issues, and README from GitHub repos listed in `ccs.yaml`. Writes raw files into `raw/github/`.

```yaml
# ccs.yaml
sources:
  - type: github
    repos:
      - my-org/auth-svc
      - my-org/payment-svc
    include: [commits, prs, issues, readme]
    token_env: GH_TOKEN
```

```
> /sync
  ✓ github:my-org/auth-svc — 4 file(s) written
  ✓ github:my-org/payment-svc — 4 file(s) written
```

---

### `/ingest`

Reads everything in `raw/` and converts it to Markdown wiki pages in `wiki/`. Re-running merges new content — never overwrites.

- **HTML files** → `wiki/concepts/{slug}.md`
- **conversations.json** → one page per conversation in `wiki/conversations/`

```
> /ingest
✓ Created 8 new wiki page(s):
  + wiki/concepts/auth-svc.md
  + wiki/conversations/react-hooks-2024.md
↻ Merged new content into 2 existing page(s)

Run /enrich to add AI summaries and links.
```

Each wiki page gets standard frontmatter:
```yaml
---
title: auth-svc
type: concept
source: raw/github/auth-svc-readme.html
last_synced: 2026-04-22
staleness: fresh
---
```

---

### `/enrich`

Sends each un-enriched wiki page to the configured LLM. Gets back:
- `summary` — one paragraph summary
- `tags` — keyword list
- `relatedTitles` — list of other pages this relates to

Injects summary + tags into frontmatter. Appends `## Related` section with `[[wikilinks]]`. Safe to re-run — skips pages that already have a summary.

```
> /enrich
Provider: anthropic/claude-sonnet-4-6

✓ Enriched 8 page(s) with summaries, tags, and [[wikilinks]]

Run /graph to rebuild the knowledge graph.
```

---

### `/graph`

Builds an interactive vis.js knowledge graph from `wiki/`. Opens `output/graph.html` in the browser automatically.

**Node building:**
- One node per wiki page
- Size = 7 + min(22, connections × 2.5)
- Color = topic group — vivid jewel tones (code=purple, design=pink, ai=green, data=yellow, devops=blue…)
- Glow shadow per node color (Obsidian-style)

**Edge building:**
- Extract keywords from title + summary
- Pages sharing keywords get edges
- Filter: keywords appearing in 2–30 nodes only
- Cap: 12 connections per node

**Interactions:**
- Hover node → fades out unconnected nodes, brightens connected cluster
- Click node → info panel with summary + tags
- Search bar → filters nodes live as you type
- Legend click → isolates a topic group

```
> /graph
Graph built: 24 nodes, 41 edges
Saved to: output/graph.html

Opening in browser…
```

---

### `/ask <question>`

TF-IDF keyword search across all wiki pages. Top 6 matching pages injected into LLM context. LLM answers with `[[page-title]]` citations.

**Scoring:**
- Title token match: 5×
- Tag match: 3×
- Body term frequency: 1 + log(freq)
- Normalized by query length

```
> /ask what does auth-svc depend on?

Searching wiki… found 3 relevant page(s)

[[auth-svc]] depends on [[user-svc]] for session validation
and [[notification-svc]] for verification emails…

## Sources
- auth-svc · dependency-map · architecture-decisions
```

---

### `/guide`

Generates and opens `~/.ccs/guide.html` — a full interactive HTML guide with:
- Step-by-step pipeline walkthrough with command examples
- Mermaid flowcharts (pipeline + decision tree)
- All commands with descriptions
- Provider configuration reference

```
> /guide
Opening guide in browser…
Saved to: /Users/you/.ccs/guide.html
```

---

### `/index`

Rebuilds `wiki/_master-index.md` — a single file listing every wiki page with title, type, and tags.

```
> /index
Master index rebuilt: 24 pages indexed
Written to: wiki/_master-index.md
```

---

### `/lint`

Wiki health check. Reports orphan pages, broken links, stale content, missing frontmatter.

---

## Vault structure

```
vault/
├── ccs.yaml                      ← sources + LLM provider config
├── raw/                          ← sync inbox (never edit manually)
│   ├── github/                   ← /sync writes here
│   └── uploads/                  ← drop local files here
├── wiki/                         ← auto-maintained by /ingest + /enrich
│   ├── _master-index.md          ← /index rebuilds this
│   ├── concepts/                 ← from HTML + text
│   └── conversations/            ← from conversations.json
├── output/
│   ├── graph.html                ← vis.js graph (/graph)
│   └── rewrite-context/
├── skills/
│   ├── wiki-ingest/SKILL.md
│   ├── wiki-query/SKILL.md
│   ├── wiki-lint/SKILL.md + lint_wiki.py
│   ├── graph-build/SKILL.md
│   └── rewrite-plan/SKILL.md
└── .claude-plugin/plugin.json    ← Claude Code manifest

~/.ccs/config.json                ← global: stores activeVault path
~/.ccs/guide.html                 ← /guide output
```

---

## LLM providers

Configure in `ccs.yaml` + env variables. Used by `/enrich` and `/ask`.

| Provider | env vars | yaml |
|---|---|---|
| Enterprise (Azure OpenAI) | `CCS_ENTERPRISE_CLIENT_ID`, `CCS_ENTERPRISE_CLIENT_SECRET`, `CCS_ENTERPRISE_AUTH_URL`, `CCS_ENTERPRISE_SCOPE`, `CCS_ENTERPRISE_API_BASE` | `provider: enterprise` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `provider: anthropic` |
| OpenAI | `OPENAI_API_KEY` | `provider: openai` |

```yaml
# ccs.yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-6
```

---

## Welcome screen

On startup CCS Code shows a welcome screen that disappears on first input.

**Wide terminal (≥ 95 columns):** two-column layout — logo + identity on left, pipeline steps with tips on right, separated by a vertical divider.

**Compact terminal (< 95 columns):** single column — logo, tagline, numbered pipeline steps, hint to type `?` for help.

Both layouts respond live to terminal resize.

---

## Integration with AI tools

The vault is plain Markdown. Any AI tool that reads files can use it.

| Tool | How to use |
|---|---|
| Claude Code | Point at vault directory — `CLAUDE.md` + `skills/` auto-load |
| GitHub Copilot | Open vault as workspace — wiki pages appear as context |
| Cursor / Windsurf | @-reference any wiki page in chat |
| Any agent | Index `wiki/` in your vector store — frontmatter maps to metadata |

---

## Implementation status

| Feature | Status |
|---|---|
| /vault init + status | ✅ |
| /sync (GitHub) | ✅ |
| /ingest (HTML + conversations.json, merge) | ✅ |
| /enrich (LLM summaries + wikilinks) | ✅ |
| /graph (vis.js, Obsidian-style glow, hover/search/filter) | ✅ |
| /ask (TF-IDF RAG + LLM) | ✅ |
| /index (master index rebuild) | ✅ |
| /guide (Mermaid HTML guide) | ✅ |
| Azure OpenAI provider | ✅ |
| Anthropic provider | ✅ |
| OpenAI provider | ✅ |
| MarkdownText rendering (bold, code blocks, bullets) | ✅ |
| WelcomeBox (wide two-column + compact, responsive) | ✅ |
| CCSSpinner with rotating labels | ✅ |
| Completion labels (Cooked for Xs) | ✅ |
| /lint (scaffold) | 🔲 |
| PDF ingestor | 🔲 |
| Confluence sync | 🔲 |
| Embedding-based semantic search | 🔲 |
