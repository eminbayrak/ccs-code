import { promises as fs } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Vault directory structure
// ---------------------------------------------------------------------------

const VAULT_DIRS = [
  ".claude-plugin",
  "skills/wiki-ingest/scripts",
  "skills/wiki-ingest/references",
  "skills/wiki-query",
  "skills/wiki-lint/scripts",
  "skills/graph-build/scripts",
  "skills/rewrite-plan/scripts",
  "raw/github",
  "raw/confluence",
  "raw/vscode",
  "raw/uploads",
  "wiki/services",
  "wiki/architecture/decisions",
  "wiki/patterns",
  "wiki/people",
  "output/rewrite-context",
  "output/reports",
];

// ---------------------------------------------------------------------------
// SKILL.md templates
// ---------------------------------------------------------------------------

const WIKI_INGEST_SKILL = `---
name: wiki-ingest
description: Use when the user adds a new source (URL, PDF, markdown file, code repo link) to raw/ and wants it integrated into the wiki. Triggers on "ingest", "add to wiki", "process this article", "read this and file it", or when files appear in raw/ that have not been processed.
---

# Wiki Ingest Skill

You are a disciplined knowledge compiler. Your job: turn raw sources into structured,
cross-linked wiki pages.

## Workflow

1. Read the source file from \`raw/\` (or fetch the URL if provided).
2. Extract: key entities, concepts, ADRs, services mentioned, code patterns.
3. For each entity, check if \`wiki/{category}/{entity}.md\` exists:
   - If yes → update it. Merge new info, never overwrite.
   - If no → create it with standard frontmatter.
4. Inject \`[[wikilinks]]\` between entities based on co-occurrence.
5. Update \`wiki/_master-index.md\` to reflect new pages.
6. Append a log entry to \`wiki/_ingest-log.md\`.

## Frontmatter Standard

Every wiki page must include:
\`\`\`yaml
type: service | adr | pattern | person | concept
name: {slug}
tags: [...]
last_synced: {ISO timestamp}
staleness: fresh
\`\`\`

## Tools Available

- \`scripts/extract_entities.py\` — LLM-powered entity extraction
- \`scripts/merge_page.py\` — safe merge into existing wiki page
- Python: \`obsidiantools\`, \`python-frontmatter\`

## Do Not

- Overwrite existing wiki pages. Always merge.
- Create pages for entities mentioned only once — needs ≥2 mentions across sources.
- Touch files outside \`wiki/\` and \`raw/\`.
`;

const WIKI_QUERY_SKILL = `---
name: wiki-query
description: Use when the user asks a question that can be answered from the knowledge base. Triggers on questions about services, architecture, decisions, patterns, or owners. Examples: "what does payment-svc depend on?", "who owns auth-svc?", "what ADRs relate to authentication?"
---

# Wiki Query Skill

Answer by reading the wiki. Never answer from training data when the wiki has relevant pages.

## Workflow

1. Read \`wiki/_master-index.md\` first to understand what exists.
2. Identify relevant wiki pages based on the question.
3. Read those pages.
4. If the answer requires graph traversal (e.g. "what calls payment-svc?"),
   invoke \`graph-build\` skill or call obsidiantools directly:
   \`\`\`python
   import obsidiantools.api as otools
   vault = otools.Vault("./").connect().gather()
   backlinks = vault.get_backlinks("payment-svc")
   \`\`\`
5. Answer with citations: \`[[wiki-page-name]]\` format.
6. If the wiki lacks the answer, say so explicitly and suggest an ingest.

## Output Format

Answer in prose. End with a \`## Sources\` section listing every wiki page cited.
`;

const WIKI_LINT_SKILL = `---
name: wiki-lint
description: Use when the user asks to check wiki health, find broken links, detect orphan pages, or spot stale content. Triggers on "lint the wiki", "check my vault", "find orphans", "what's stale?", "wiki health check".
---

# Wiki Lint Skill

Run health checks on the vault. Report issues, do not auto-fix without permission.

## Checks

1. **Broken wikilinks** — \`[[foo]]\` where \`foo.md\` doesn't exist
2. **Orphan pages** — wiki pages with zero backlinks (use obsidiantools)
3. **Staleness** — pages where \`last_synced\` > 30 days and source changed
4. **Missing frontmatter** — pages without \`type\` field
5. **Circular deps** — services in dependency cycles (use networkx)
6. **Contradictions** — pages making opposing claims about the same entity

## Tools

- Python: \`obsidiantools\` for broken links and orphans
- Python: \`networkx.simple_cycles\` for circular dependencies
- \`scripts/lint_wiki.py\` — runs all 6 checks in one pass

## Output

A structured report with severity levels (CRITICAL / WARNING / INFO) and suggested fixes.
`;

const GRAPH_BUILD_SKILL = `---
name: graph-build
description: Use when the user wants to generate or view the knowledge graph visualization. Triggers on "show me the graph", "visualize the vault", "build the graph", "open graph view", "rebuild graph".
---

# Graph Build Skill

Generate the interactive pyvis graph of the vault.

## Workflow

1. Run \`scripts/build_graph.py\` — parses vault with obsidiantools, renders with pyvis.
2. Output: \`output/graph.html\` — standalone interactive HTML.
3. If obsidian-python-bridge is installed and Obsidian is running,
   optionally refresh Obsidian's native graph view.
4. Report stats: node count, edge count, isolated notes, densest clusters.

## Customization

Before building, ask the user:
- Color nodes by: type (default) | staleness | owner
- Size nodes by: connection count (default) | pagerank | uniform
- Layout: forceAtlas2 (default) | hierarchical | barnesHut

See \`scripts/build_graph.py\` for implementation.
`;

const REWRITE_PLAN_SKILL = `---
name: rewrite-plan
description: Use when the user is planning a microservice rewrite and needs context. Triggers on "plan the rewrite of X", "rewrite brief for X", "what do I need to know to rewrite X", "rewrite order", "which service should I rewrite first?".
---

# Rewrite Plan Skill

Generate a full rewrite context brief for a target service, or a rewrite sequence for the
whole system.

## Single-Service Brief

For \`rewrite plan --service payment-svc\`:

1. Read \`wiki/services/payment-svc.md\`
2. Load graph via obsidiantools
3. Compute via networkx:
   - Direct dependencies (outgoing edges)
   - Dependents (incoming edges)
   - PageRank position → rewrite risk score
   - Is this service in a cycle?
4. Pull related ADRs from \`wiki/architecture/decisions/\`
5. Pull open issues from \`raw/github/\`
6. Pull owners from \`wiki/people/\`
7. Write \`output/rewrite-context/{service}-rewrite-brief.md\`

## System-Wide Order

For "what order should I rewrite in?":

1. Load full graph via obsidiantools
2. Run \`networkx.topological_sort(G)\` — leaves first, core last
3. Flag any cycles explicitly — these need manual resolution before ordering
4. Rank by PageRank — higher = more dependents = higher risk
5. Output: numbered list with risk annotations

## Tools

- \`scripts/analyze_rewrite.py\` — full analysis pipeline
`;

// ---------------------------------------------------------------------------
// Python script templates
// ---------------------------------------------------------------------------

const BUILD_GRAPH_PY = `#!/usr/bin/env python3
"""
CCS Code — Graph Build Script
Parses the vault with obsidiantools and renders an interactive pyvis graph.

Usage:
    python build_graph.py [--vault VAULT_PATH] [--output OUTPUT_PATH]
    python build_graph.py [--color-by type|staleness] [--layout forceAtlas2|hierarchical]
"""
import sys
import json
from pathlib import Path
from datetime import datetime, timezone

# Color mapping for node types
TYPE_COLORS = {
    "service": "#6366f1",
    "adr": "#f97316",
    "pattern": "#38bdf8",
    "person": "#4ade80",
    "concept": "#a78bfa",
}

STALENESS_COLORS = {
    "fresh": "#4ade80",
    "stale": "#f97316",
    "critical": "#ef4444",
}

def build_graph(vault_path: str, output_path: str, color_by: str = "type") -> dict:
    vault_root = Path(vault_path)
    wiki_dir = vault_root / "wiki"

    if not wiki_dir.exists():
        return {"error": f"Wiki directory not found: {wiki_dir}"}

    try:
        import obsidiantools.api as otools
        vault = otools.Vault(str(wiki_dir)).connect().gather()
        G = vault.graph
    except ImportError:
        return build_graph_fallback(wiki_dir, output_path, color_by)
    except Exception as e:
        return {"error": f"obsidiantools failed: {e}"}

    try:
        from pyvis.network import Network
        net = Network(
            height="100vh",
            width="100%",
            bgcolor="#0d0d0f",
            font_color="#e2e8f0",
            directed=True,
        )

        for node in G.nodes():
            meta = vault.get_note_metadata(node) or {}
            node_type = meta.get("type", "concept")
            staleness = meta.get("staleness", "fresh")
            color = TYPE_COLORS.get(node_type, "#94a3b8") if color_by == "type" else STALENESS_COLORS.get(staleness, "#94a3b8")
            degree = G.degree(node) if hasattr(G, "degree") else 1
            net.add_node(node, label=node, color=color, size=max(10, min(50, degree * 4)), title=f"type: {node_type}\\nstaleness: {staleness}")

        for src, dst in G.edges():
            net.add_edge(src, dst)

        net.set_options('''{
            "physics": {
                "forceAtlas2Based": {
                    "gravitationalConstant": -50,
                    "centralGravity": 0.01,
                    "springLength": 100
                },
                "solver": "forceAtlas2Based"
            },
            "interaction": {"hover": true}
        }''')

        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        net.write_html(str(out_path))

        isolated = list(vault.isolated_notes) if hasattr(vault, "isolated_notes") else []
        stats = {
            "nodes": G.number_of_nodes(),
            "edges": G.number_of_edges(),
            "isolated": len(isolated),
            "output": str(out_path),
        }
        return stats

    except ImportError:
        return {"error": "pyvis not installed. Run: pip install pyvis"}


def build_graph_fallback(wiki_dir: Path, output_path: str, color_by: str) -> dict:
    """Fallback: parse wikilinks manually from markdown files."""
    import re

    nodes: dict[str, dict] = {}
    edges: list[tuple[str, str]] = []
    wikilink_re = re.compile(r"\\[\\[([^\\]]+)\\]\\]")

    for md_file in wiki_dir.rglob("*.md"):
        if md_file.name.startswith("_"):
            continue
        slug = md_file.stem
        content = md_file.read_text(encoding="utf-8", errors="replace")
        fm: dict = {}
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                for line in parts[1].splitlines():
                    if ":" in line:
                        k, _, v = line.partition(":")
                        fm[k.strip()] = v.strip()
        nodes[slug] = fm
        for link in wikilink_re.findall(content):
            edges.append((slug, link.split("|")[0].strip()))

    try:
        from pyvis.network import Network
        net = Network(height="100vh", width="100%", bgcolor="#0d0d0f", font_color="#e2e8f0", directed=True)
        for slug, meta in nodes.items():
            node_type = meta.get("type", "concept")
            color = TYPE_COLORS.get(node_type, "#94a3b8")
            net.add_node(slug, label=slug, color=color, size=14)
        for src, dst in edges:
            if src in nodes and dst in nodes:
                net.add_edge(src, dst)
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        net.write_html(str(out_path))
        return {"nodes": len(nodes), "edges": len(edges), "output": str(out_path)}
    except ImportError:
        return {"error": "pyvis not installed. Run: pip install pyvis", "nodes": len(nodes), "edges": len(edges)}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", default=".", help="Path to vault root")
    parser.add_argument("--output", default="output/graph.html")
    parser.add_argument("--color-by", default="type", choices=["type", "staleness"])
    args = parser.parse_args()
    result = build_graph(args.vault, args.output, args.color_by)
    print(json.dumps(result, indent=2))
`;

const ANALYZE_REWRITE_PY = `#!/usr/bin/env python3
"""
CCS Code — Rewrite Analysis Script
Computes rewrite order and risk scores for microservices using graph analytics.

Usage:
    python analyze_rewrite.py --vault VAULT_PATH --service SERVICE_SLUG
    python analyze_rewrite.py --vault VAULT_PATH --order   # system-wide order
"""
import sys
import json
import re
from pathlib import Path
from datetime import datetime, timezone


def load_service_graph(wiki_dir: Path) -> "nx.DiGraph":
    try:
        import obsidiantools.api as otools
        vault = otools.Vault(str(wiki_dir)).connect().gather()
        return vault.graph
    except ImportError:
        pass

    import networkx as nx
    G = nx.DiGraph()
    wikilink_re = re.compile(r"\\[\\[([^\\]]+)\\]\\]")
    for md_file in (wiki_dir / "services").glob("*.md"):
        slug = md_file.stem
        G.add_node(slug)
        content = md_file.read_text(encoding="utf-8", errors="replace")
        for link in wikilink_re.findall(content):
            target = link.split("|")[0].strip()
            G.add_edge(slug, target)
    return G


def analyze_service(vault_path: str, service: str) -> dict:
    import networkx as nx

    vault_root = Path(vault_path)
    wiki_dir = vault_root / "wiki"
    services_dir = wiki_dir / "services"

    service_file = services_dir / f"{service}.md"
    if not service_file.exists():
        return {"error": f"Service page not found: wiki/services/{service}.md"}

    G = load_service_graph(wiki_dir)

    pagerank = nx.pagerank(G) if G.number_of_nodes() > 0 else {}
    cycles = list(nx.simple_cycles(G))
    in_cycle = any(service in c for c in cycles)
    deps_out = list(G.successors(service)) if service in G else []
    deps_in = list(G.predecessors(service)) if service in G else []
    risk_score = round(pagerank.get(service, 0) * 100, 2)

    content = service_file.read_text(encoding="utf-8", errors="replace")
    fm: dict = {}
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    fm[k.strip()] = v.strip().strip('"').strip("'")

    adrs = []
    adr_dir = wiki_dir / "architecture" / "decisions"
    if adr_dir.exists():
        for adr_file in adr_dir.glob("*.md"):
            adr_content = adr_file.read_text(encoding="utf-8", errors="replace")
            if service in adr_content:
                adrs.append(adr_file.stem)

    brief_lines = [
        f"# Rewrite Brief: {service}",
        "",
        f"_Generated: {datetime.now(timezone.utc).isoformat()}_",
        "",
        "## Service Overview",
        "",
        f"- **Name**: {service}",
        f"- **Owners**: {fm.get('owners', 'unknown')}",
        f"- **Repo**: {fm.get('repo', 'unknown')}",
        f"- **Tags**: {fm.get('tags', '')}",
        "",
        "## Risk Analysis",
        "",
        f"- **PageRank risk score**: {risk_score}%",
        f"- **In dependency cycle**: {'YES — resolve before rewriting' if in_cycle else 'No'}",
        f"- **Dependents (callers)**: {', '.join(deps_in) if deps_in else 'none'}",
        f"- **Dependencies (calls)**: {', '.join(deps_out) if deps_out else 'none'}",
        "",
        "## Related ADRs",
        "",
        *([f"- [[{a}]]" for a in adrs] if adrs else ["- None found"]),
        "",
        "## Dependency Cycles",
        "",
        *([f"- {' → '.join(c)}" for c in cycles] if cycles else ["- No cycles detected"]),
        "",
        "## Recommended Rewrite Approach",
        "",
        "1. Freeze public API surface first",
        "2. Rewrite leaf dependencies before this service",
        "3. Use strangler-fig pattern if service is in a cycle",
        "",
        "## Wiki Source",
        "",
        f"[[{service}]]",
    ]

    out_path = vault_root / "output" / "rewrite-context" / f"{service}-rewrite-brief.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\\n".join(brief_lines), encoding="utf-8")

    return {
        "service": service,
        "risk_score": risk_score,
        "in_cycle": in_cycle,
        "dependents": deps_in,
        "dependencies": deps_out,
        "related_adrs": adrs,
        "brief": str(out_path),
    }


def system_rewrite_order(vault_path: str) -> dict:
    import networkx as nx

    vault_root = Path(vault_path)
    wiki_dir = vault_root / "wiki"
    G = load_service_graph(wiki_dir)

    if G.number_of_nodes() == 0:
        return {"error": "No services found in wiki/services/"}

    pagerank = nx.pagerank(G)
    cycles = list(nx.simple_cycles(G))

    cycle_nodes: set[str] = set()
    for c in cycles:
        cycle_nodes.update(c)

    G_acyclic = G.copy()
    for c in cycles:
        for i in range(len(c)):
            try:
                G_acyclic.remove_edge(c[i], c[(i + 1) % len(c)])
            except Exception:
                pass

    try:
        order = list(nx.topological_sort(G_acyclic))
    except nx.NetworkXUnfeasible:
        order = sorted(G.nodes(), key=lambda n: pagerank.get(n, 0))

    ranked = [
        {
            "rank": i + 1,
            "service": svc,
            "risk": round(pagerank.get(svc, 0) * 100, 2),
            "in_cycle": svc in cycle_nodes,
        }
        for i, svc in enumerate(order)
    ]

    return {
        "order": ranked,
        "cycles": cycles,
        "total_services": len(order),
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", default=".", help="Path to vault root")
    parser.add_argument("--service", help="Analyze a specific service")
    parser.add_argument("--order", action="store_true", help="Print system-wide rewrite order")
    args = parser.parse_args()

    if args.order:
        result = system_rewrite_order(args.vault)
    elif args.service:
        result = analyze_service(args.vault, args.service)
    else:
        parser.print_help()
        sys.exit(1)

    print(json.dumps(result, indent=2))
`;

const LINT_WIKI_PY = `#!/usr/bin/env python3
"""
CCS Code — Wiki Lint Script
Runs health checks on the vault and produces a severity-annotated report.

Checks:
  1. Broken wikilinks
  2. Orphan pages (zero backlinks)
  3. Stale pages (last_synced > 30 days)
  4. Missing frontmatter (no 'type' field)
  5. Circular dependencies (networkx)

Usage:
    python lint_wiki.py [--vault VAULT_PATH]
"""
import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path


def parse_frontmatter(content: str) -> dict:
    fm: dict = {}
    if not content.startswith("---"):
        return fm
    parts = content.split("---", 2)
    if len(parts) < 3:
        return fm
    for line in parts[1].splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm


def extract_wikilinks(content: str) -> list[str]:
    return [m.split("|")[0].strip() for m in re.findall(r"\\[\\[([^\\]]+)\\]\\]", content)]


def run_lint(vault_path: str) -> dict:
    vault_root = Path(vault_path)
    wiki_dir = vault_root / "wiki"

    if not wiki_dir.exists():
        return {"error": f"Wiki directory not found: {wiki_dir}"}

    # Build slug → file map and content map
    slug_map: dict[str, Path] = {}
    content_map: dict[str, str] = {}
    for md_file in wiki_dir.rglob("*.md"):
        if md_file.name.startswith("_"):
            continue
        slug = md_file.stem
        slug_map[slug] = md_file
        content_map[slug] = md_file.read_text(encoding="utf-8", errors="replace")

    issues: list[dict] = []
    now = datetime.now(timezone.utc)
    stale_threshold = timedelta(days=30)
    backlink_counts: dict[str, int] = {slug: 0 for slug in slug_map}

    for slug, content in content_map.items():
        fm = parse_frontmatter(content)
        links = extract_wikilinks(content)

        # Track backlinks
        for link in links:
            if link in backlink_counts:
                backlink_counts[link] += 1

        # Check 1: Broken wikilinks
        for link in links:
            if link not in slug_map:
                issues.append({
                    "severity": "WARNING",
                    "check": "broken_wikilink",
                    "page": slug,
                    "detail": f"[[{link}]] target does not exist",
                })

        # Check 4: Missing frontmatter
        if "type" not in fm:
            issues.append({
                "severity": "WARNING",
                "check": "missing_frontmatter",
                "page": slug,
                "detail": "Page is missing 'type' in frontmatter",
            })

        # Check 3: Stale pages
        if "last_synced" in fm:
            try:
                synced = datetime.fromisoformat(fm["last_synced"].replace("Z", "+00:00"))
                if now - synced > stale_threshold:
                    days_old = (now - synced).days
                    issues.append({
                        "severity": "INFO",
                        "check": "stale_page",
                        "page": slug,
                        "detail": f"last_synced is {days_old} days ago",
                    })
            except ValueError:
                pass

    # Check 2: Orphan pages
    for slug, count in backlink_counts.items():
        if count == 0:
            issues.append({
                "severity": "INFO",
                "check": "orphan_page",
                "page": slug,
                "detail": "No pages link to this page",
            })

    # Check 5: Circular dependencies (networkx)
    try:
        import networkx as nx
        G = nx.DiGraph()
        for slug, content in content_map.items():
            G.add_node(slug)
            for link in extract_wikilinks(content):
                if link in slug_map:
                    G.add_edge(slug, link)
        for cycle in nx.simple_cycles(G):
            issues.append({
                "severity": "CRITICAL",
                "check": "circular_dependency",
                "page": cycle[0],
                "detail": f"Cycle detected: {' → '.join(cycle)}",
            })
    except ImportError:
        issues.append({
            "severity": "INFO",
            "check": "skipped",
            "page": "system",
            "detail": "networkx not installed — skipping circular dependency check",
        })

    # Write report
    severity_order = {"CRITICAL": 0, "WARNING": 1, "INFO": 2}
    issues.sort(key=lambda i: severity_order.get(i["severity"], 3))

    report_lines = [
        "# Wiki Lint Report",
        "",
        f"_Generated: {now.isoformat()}_",
        f"_Total pages: {len(slug_map)} | Issues found: {len(issues)}_",
        "",
    ]
    for issue in issues:
        icon = {"CRITICAL": "🔴", "WARNING": "🟡", "INFO": "🔵"}.get(issue["severity"], "⚪")
        report_lines.append(f"{icon} **{issue['severity']}** [{issue['check']}] \`{issue['page']}\` — {issue['detail']}")

    report_path = vault_root / "output" / "reports" / "lint-report.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\\n".join(report_lines), encoding="utf-8")

    return {
        "total_pages": len(slug_map),
        "total_issues": len(issues),
        "critical": sum(1 for i in issues if i["severity"] == "CRITICAL"),
        "warnings": sum(1 for i in issues if i["severity"] == "WARNING"),
        "info": sum(1 for i in issues if i["severity"] == "INFO"),
        "report": str(report_path),
        "issues": issues,
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", default=".", help="Path to vault root")
    args = parser.parse_args()
    result = run_lint(args.vault)
    print(json.dumps(result, indent=2))
`;

const EXTRACT_ENTITIES_PY = `#!/usr/bin/env python3
"""
CCS Code — Entity Extraction Script
Extracts named entities (services, patterns, people, concepts) from a raw document
using pattern matching + optional LLM classification.

Usage:
    python extract_entities.py --file FILE_PATH [--output JSON_PATH]
"""
import json
import re
from pathlib import Path


def extract_entities(content: str) -> dict[str, list[str]]:
    """
    Heuristic entity extraction.
    Returns {"services": [...], "patterns": [...], "people": [...], "concepts": [...]}
    """
    entities: dict[str, list[str]] = {
        "services": [],
        "patterns": [],
        "people": [],
        "concepts": [],
    }

    # Service names: word-svc, word-service, word_service patterns
    services = re.findall(r"\\b([a-z][a-z0-9-]*(?:-svc|-service|Service))\\b", content)
    entities["services"] = sorted(set(s.lower().replace("service", "svc") for s in services))

    # Architecture patterns: known pattern names
    pattern_keywords = [
        "saga", "event sourcing", "cqrs", "strangler fig", "circuit breaker",
        "outbox", "choreography", "orchestration", "api gateway", "sidecar",
    ]
    for kw in pattern_keywords:
        if kw.lower() in content.lower():
            entities["patterns"].append(kw)

    # People: GitHub-style @mentions
    people = re.findall(r"@([a-zA-Z][a-zA-Z0-9_-]{1,38})", content)
    entities["people"] = sorted(set(people))

    # Concepts: capitalized noun phrases (simple heuristic)
    concepts = re.findall(r"\\b([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+){0,2})\\b", content)
    stop_words = {"The", "This", "That", "These", "With", "From", "When", "Where", "What"}
    entities["concepts"] = sorted(set(c for c in concepts if c not in stop_words))[:20]

    return entities


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    content = Path(args.file).read_text(encoding="utf-8", errors="replace")
    result = extract_entities(content)

    if args.output:
        Path(args.output).write_text(json.dumps(result, indent=2))
    else:
        print(json.dumps(result, indent=2))
`;

const MERGE_PAGE_PY = `#!/usr/bin/env python3
"""
CCS Code — Safe Page Merge Script
Merges new content into an existing wiki page without overwriting.
Appends new sections and updates frontmatter timestamps.

Usage:
    python merge_page.py --target WIKI_PAGE.md --source RAW_CONTENT.md
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def merge_frontmatter(existing: dict, incoming: dict) -> dict:
    merged = dict(existing)
    # Update tags (union)
    existing_tags = existing.get("tags", "").strip("[]").split(",")
    incoming_tags = incoming.get("tags", "").strip("[]").split(",")
    all_tags = sorted(set(t.strip() for t in existing_tags + incoming_tags if t.strip()))
    merged["tags"] = f"[{', '.join(all_tags)}]"
    # Always update last_synced
    merged["last_synced"] = datetime.now(timezone.utc).isoformat()
    merged["staleness"] = "fresh"
    # Merge depends_on
    if "depends_on" in incoming:
        existing_deps = existing.get("depends_on", "").strip("[]").split(",")
        incoming_deps = incoming.get("depends_on", "").strip("[]").split(",")
        all_deps = sorted(set(d.strip() for d in existing_deps + incoming_deps if d.strip()))
        merged["depends_on"] = f"[{', '.join(all_deps)}]"
    return merged


def parse_frontmatter(content: str) -> tuple[dict, str]:
    if not content.startswith("---"):
        return {}, content
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content
    fm: dict = {}
    for line in parts[1].splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm, parts[2].lstrip("\\n")


def merge_pages(target_path: str, source_content: str) -> dict:
    target = Path(target_path)
    if not target.exists():
        # New page — just write it
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source_content, encoding="utf-8")
        return {"action": "created", "path": str(target)}

    existing_content = target.read_text(encoding="utf-8", errors="replace")
    existing_fm, existing_body = parse_frontmatter(existing_content)
    incoming_fm, incoming_body = parse_frontmatter(source_content)

    merged_fm = merge_frontmatter(existing_fm, incoming_fm)

    # Append new body sections that don't already exist
    new_sections = re.split(r"(?m)^## ", incoming_body)
    existing_lower = existing_body.lower()
    added_sections = []
    for section in new_sections[1:]:  # skip content before first ##
        heading = section.split("\\n", 1)[0].strip().lower()
        if heading not in existing_lower:
            added_sections.append(f"## {section}")

    final_body = existing_body
    if added_sections:
        final_body += "\\n\\n---\\n_Merged by CCS Code_\\n\\n" + "".join(added_sections)

    # Rebuild frontmatter
    yaml_lines = "\\n".join(f"{k}: {v}" for k, v in merged_fm.items())
    final_content = f"---\\n{yaml_lines}\\n---\\n{final_body}"
    target.write_text(final_content, encoding="utf-8")

    return {
        "action": "merged",
        "path": str(target),
        "added_sections": len(added_sections),
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, help="Target wiki page path")
    parser.add_argument("--source", required=True, help="Source raw content file path")
    args = parser.parse_args()

    source = Path(args.source).read_text(encoding="utf-8", errors="replace")
    result = merge_pages(args.target, source)
    print(json.dumps(result, indent=2))
`;

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const PLUGIN_JSON = JSON.stringify(
  {
    name: "ccs-code",
    version: "1.0.0",
    description:
      "Obsidian RAG knowledge base for microservice rewrites. Auto-ingests from GitHub, Confluence, VSCode. Karpathy LLM Wiki pattern.",
    skills_dir: "./skills",
    activation: {
      auto_activate_on_directory: [".obsidian"],
    },
  },
  null,
  2,
);

const CLAUDE_MD = `# CCS Code Vault

This directory is a CCS Code vault. The knowledge base follows Karpathy's LLM Wiki pattern.

## Rules for the Agent

- \`raw/\` is an inbox. Never edit files there.
- \`wiki/\` is your domain. Every file needs frontmatter with \`type\`, \`name\`, \`tags\`, \`last_synced\`.
- \`output/\` is for generated artifacts. Safe to overwrite.
- Before answering questions, invoke the \`wiki-query\` skill.
- Before adding content, invoke the \`wiki-ingest\` skill.
- When asked about service rewrites, invoke the \`rewrite-plan\` skill.

## Naming

Service pages: \`wiki/services/{slug}.md\`
ADRs: \`wiki/architecture/decisions/adr-{N}.md\`
People: \`wiki/people/{github-username}.md\`

## Tooling

Python packages: obsidiantools, pyvis, networkx, python-frontmatter.
CLI: \`ccs-code {command}\` — see \`ccs-code --help\`.
`;

const CCS_YAML = `vault:
  path: ./vault
  auto_sync: true
  sync_interval: 6h

skills:
  enabled: true
  install_to: ./skills
  auto_activate_on_obsidian: true

sources: []
#  - type: github
#    repos: [my-org/auth-svc, my-org/payment-svc]
#    include: [commits, prs, issues, readme, file_tree]
#    token_env: GH_TOKEN
#  - type: confluence
#    url: https://myco.atlassian.net
#    spaces: [ENG, ARCH]
#    token_env: CONFLUENCE_TOKEN

graph:
  output: output/graph.html
  physics: forceAtlas2Based
  node_color_by: type
  node_size_by: connections
`;

const MASTER_INDEX_INITIAL = `# Knowledge Base Master Index

_Last rebuilt: (not yet built)_
_Total pages: 0_

## Getting Started

Run \`/ingest\` or drop files into \`raw/uploads/\` to populate this wiki.
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initVault(vaultPath: string): Promise<string[]> {
  const created: string[] = [];

  // Create directory tree
  for (const dir of VAULT_DIRS) {
    const fullPath = join(vaultPath, dir);
    await fs.mkdir(fullPath, { recursive: true });
  }

  // Helper to write a file (skips if exists)
  async function writeFile(relPath: string, content: string, overwrite = false) {
    const fullPath = join(vaultPath, relPath);
    if (!overwrite) {
      try {
        await fs.access(fullPath);
        return; // already exists
      } catch {
        // doesn't exist, proceed
      }
    }
    await fs.writeFile(fullPath, content, "utf-8");
    created.push(relPath);
  }

  // Skills
  await writeFile("skills/wiki-ingest/SKILL.md", WIKI_INGEST_SKILL);
  await writeFile("skills/wiki-query/SKILL.md", WIKI_QUERY_SKILL);
  await writeFile("skills/wiki-lint/SKILL.md", WIKI_LINT_SKILL);
  await writeFile("skills/graph-build/SKILL.md", GRAPH_BUILD_SKILL);
  await writeFile("skills/rewrite-plan/SKILL.md", REWRITE_PLAN_SKILL);

  // Python scripts
  await writeFile("skills/graph-build/scripts/build_graph.py", BUILD_GRAPH_PY);
  await writeFile("skills/rewrite-plan/scripts/analyze_rewrite.py", ANALYZE_REWRITE_PY);
  await writeFile("skills/wiki-lint/scripts/lint_wiki.py", LINT_WIKI_PY);
  await writeFile("skills/wiki-ingest/scripts/extract_entities.py", EXTRACT_ENTITIES_PY);
  await writeFile("skills/wiki-ingest/scripts/merge_page.py", MERGE_PAGE_PY);

  // Plugin manifest
  await writeFile(".claude-plugin/plugin.json", PLUGIN_JSON);

  // CLAUDE.md
  await writeFile("CLAUDE.md", CLAUDE_MD);

  // ccs.yaml
  await writeFile("ccs.yaml", CCS_YAML);

  // Wiki master index placeholder
  await writeFile("wiki/_master-index.md", MASTER_INDEX_INITIAL);
  await writeFile("wiki/_ingest-log.md", "# Ingest Log\n\n_No items ingested yet._\n");

  // README for raw/
  await writeFile(
    "raw/README.md",
    "# Raw Inbox\n\nDrop files here or use `ccs-code sync` to populate from sources.\nDo not edit files in this directory — they are managed by CCS Code.\n",
  );

  return created;
}
