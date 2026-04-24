import { promises as fs } from "fs";
import { join } from "path";
import {
  searchOrgCode,
  fetchFileTree,
  parseRepoUrl,
} from "../connectors/github.js";
import type { LLMProvider } from "../llm/providers/base.js";

export type ResolvedService = {
  repoFullName: string;
  filePath: string;
  htmlUrl: string;
  confidence: "exact" | "likely" | "ambiguous";
};

export type GithubConfig = {
  org: string;
  token?: string;
  host?: string;
};

const SERVICE_EXTENSIONS = [".cs", ".asmx", ".java", ".vb", ".cls", ".bas", ".cpp", ".py"];

// ---------------------------------------------------------------------------
// Candidate filenames — used by local clone search
// ---------------------------------------------------------------------------

function candidateFilenames(namespace: string): string[] {
  return [
    `${namespace}.cs`,
    `${namespace}Service.cs`,
    `${namespace}Impl.cs`,
    `${namespace}.asmx.cs`,
    `${namespace}.java`,
    `${namespace}ServiceImpl.java`,
    `${namespace}.vb`,
    `${namespace}.cls`,
    `${namespace}.bas`,
  ];
}

// ---------------------------------------------------------------------------
// LLM ranking — picks the best candidate from a list of names.
// Receives only repo/path strings — makes ZERO additional API calls.
// ---------------------------------------------------------------------------

async function rankCandidates(
  provider: LLMProvider,
  namespace: string,
  candidates: ResolvedService[],
): Promise<ResolvedService> {
  const list = candidates.map((c, i) => `${i + 1}. ${c.repoFullName}/${c.filePath}`).join("\n");

  const response = await provider.chat(
    [
      {
        role: "user",
        content: `Which of these files is most likely the main implementation of the "${namespace}" SOAP/WCF/COM service?\n\n${list}\n\nRespond ONLY with JSON: {"choice": <number>}`,
      },
    ],
    "You resolve legacy service names to source files. Avoid interfaces (I prefix), tests, and mocks. Respond only with valid JSON."
  );

  try {
    const json = response.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const parsed = JSON.parse(json) as { choice?: number };
    const idx = (parsed.choice ?? 1) - 1;
    return (candidates[Math.max(0, Math.min(idx, candidates.length - 1))] ?? candidates[0]) as ResolvedService;
  } catch {
    return candidates[0] as ResolvedService;
  }
}

// ---------------------------------------------------------------------------
// Deterministic 2-call resolver
//
// Call 1: filename:<Namespace>   → matches any extension in one query
//         (.cs, .vb, .cls, .java etc. all returned, no per-extension loops)
// Call 2: "<Namespace>"          → broader string search, only if Call 1 empty
//
// Rules:
//  - 403 / rate-limit → return null immediately, never retry
//  - Multiple matches → LLM picks from names only (zero extra API calls)
//  - Entry repo preferred over other matches when confidence is equal
// ---------------------------------------------------------------------------

async function resolveWithSearch(
  namespace: string,
  config: GithubConfig,
  provider: LLMProvider,
  entryRepoUrl?: string,
  onProgress?: (msg: string) => void,
): Promise<ResolvedService | null> {
  const entryParsed = entryRepoUrl ? parseRepoUrl(entryRepoUrl) : null;
  const entryRepoName = entryParsed ? `${entryParsed.owner}/${entryParsed.repo}` : null;
  const host = config.host ?? "github.com";

  // Returns results array, "rate_limited" sentinel, or [] on other errors
  async function doSearch(
    query: string,
  ): Promise<Array<{ repoFullName: string; filePath: string; htmlUrl: string }> | "rate_limited"> {
    try {
      onProgress?.(`Searching: org:${config.org} ${query}`);
      const results = await searchOrgCode(config.org, query, config.token, config.host);
      return results;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("403") || msg.includes("rate limit") || msg.includes("rate limited")) {
        onProgress?.(`  ✗ GitHub rate limited — skipping ${namespace}`);
        return "rate_limited";
      }
      return [];
    }
  }

  // Strip tests, mocks, interfaces; require known service extension
  function filterImpl(
    results: Array<{ repoFullName: string; filePath: string; htmlUrl: string }>,
  ) {
    return results.filter((r) => {
      if (/test|mock|spec|stub/i.test(r.filePath)) return false;
      const fname = r.filePath.split("/").pop() ?? "";
      if (/^I[A-Z]/.test(fname)) return false;
      const ext = r.filePath.slice(r.filePath.lastIndexOf("."));
      return SERVICE_EXTENSIONS.includes(ext);
    });
  }

  async function pickBest(
    candidates: Array<{ repoFullName: string; filePath: string; htmlUrl: string }>,
    confidence: "exact" | "likely",
  ): Promise<ResolvedService> {
    const resolved: ResolvedService[] = candidates.map((c) => ({
      ...c,
      confidence,
      htmlUrl: c.htmlUrl || `https://${host}/${c.repoFullName}/blob/HEAD/${c.filePath}`,
    }));
    if (resolved.length === 1) return resolved[0]!;
    // Prefer entry repo when confidence is equal
    if (entryRepoName) {
      const match = resolved.find((c) => c.repoFullName === entryRepoName);
      if (match) return match;
    }
    // LLM picks from names only — zero additional API calls
    return rankCandidates(provider, namespace, resolved);
  }

  // --- Call 1: exact filename (no extension = matches all extensions in one query) ---
  const call1 = await doSearch(`filename:${namespace}`);
  if (call1 === "rate_limited") return null;

  const exactMatches = filterImpl(call1);
  if (exactMatches.length > 0) {
    onProgress?.(`  → Found ${exactMatches.length} candidate${exactMatches.length === 1 ? "" : "s"}`);
    return pickBest(exactMatches, "exact");
  }
  onProgress?.(`  → No results`);

  // --- Call 2: namespace string search (broader, only when Call 1 finds nothing) ---
  const call2 = await doSearch(`"${namespace}"`);
  if (call2 === "rate_limited") return null;

  const likelyMatches = filterImpl(call2);
  if (likelyMatches.length > 0) {
    onProgress?.(`  → Found ${likelyMatches.length} candidate${likelyMatches.length === 1 ? "" : "s"}`);
    return pickBest(likelyMatches, "likely");
  }
  onProgress?.(`  → No results`);

  return null;
}

// ---------------------------------------------------------------------------
// Local clone search — walks a pre-cloned directory, zero API calls.
// Used before any network call so cached clones skip the Search API entirely.
// ---------------------------------------------------------------------------

export async function resolveLocal(
  namespace: string,
  localPath: string,
  repoFullName: string,
): Promise<ResolvedService | null> {
  const candidates = new Set(candidateFilenames(namespace));
  const extensions = new Set(SERVICE_EXTENSIONS);

  async function searchDir(dir: string): Promise<string | null> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await searchDir(full);
        if (found) return found;
      } else {
        if (candidates.has(entry.name)) return full;
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (extensions.has(ext)) {
          try {
            const content = await fs.readFile(full, "utf-8");
            if (content.includes(namespace)) return full;
          } catch { /* skip unreadable */ }
        }
      }
    }
    return null;
  }

  try {
    const found = await searchDir(localPath);
    if (found) {
      const relative = found.slice(localPath.length + 1);
      return {
        repoFullName,
        filePath: relative,
        htmlUrl: `https://github.com/${repoFullName}/blob/HEAD/${relative}`,
        confidence: "exact",
      };
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution cache — persisted across runs so each service is only searched once
// ---------------------------------------------------------------------------

async function getCachedResolution(migrationDir: string, namespace: string): Promise<ResolvedService | null> {
  try {
    const cachePath = join(migrationDir, "resolution-cache.json");
    const content = await fs.readFile(cachePath, "utf-8");
    const cache = JSON.parse(content) as Record<string, ResolvedService>;
    return cache[namespace] ?? null;
  } catch {
    return null;
  }
}

async function saveResolution(migrationDir: string, namespace: string, result: ResolvedService) {
  try {
    const cachePath = join(migrationDir, "resolution-cache.json");
    let cache: Record<string, ResolvedService> = {};
    try {
      const existing = await fs.readFile(cachePath, "utf-8");
      cache = JSON.parse(existing) as Record<string, ResolvedService>;
    } catch { /* first run */ }
    cache[namespace] = result;
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Public entry point — resolution priority:
//   1. Resolution cache  (zero API calls, instant)
//   2. Local clone search (zero API calls, walks pre-cloned dir)
//   3. GitHub Search API  (max 2 calls, fail fast on 403)
// ---------------------------------------------------------------------------

export async function resolveNamespace(
  namespace: string,
  config: GithubConfig,
  provider: LLMProvider,
  entryRepoUrl?: string,
  _methodName?: string,
  onProgress?: (msg: string) => void,
  migrationDir?: string,
  localClonePath?: string,
): Promise<ResolvedService | null> {
  // 1. Cache hit — no network at all
  if (migrationDir) {
    const cached = await getCachedResolution(migrationDir, namespace);
    if (cached) {
      onProgress?.(`  (cached) ${cached.repoFullName} / ${cached.filePath}`);
      return cached;
    }
  }

  // 2. Local clone search — walk the pre-cloned entry repo
  if (localClonePath && entryRepoUrl) {
    const entryParsed = parseRepoUrl(entryRepoUrl);
    if (entryParsed) {
      const local = await resolveLocal(namespace, localClonePath, `${entryParsed.owner}/${entryParsed.repo}`);
      if (local) {
        onProgress?.(`  Found locally in ${entryParsed.repo}`);
        if (migrationDir) await saveResolution(migrationDir, namespace, local);
        return local;
      }
    }
  }

  // 3. GitHub Search API — deterministic, max 2 calls, 403-safe
  const result = await resolveWithSearch(namespace, config, provider, entryRepoUrl, onProgress);

  if (result && migrationDir) {
    await saveResolution(migrationDir, namespace, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Find WSDL/XSD files via API tree — kept as fallback for non-cloned repos
// ---------------------------------------------------------------------------

export async function findWsdlFiles(
  repoFullName: string,
  config: GithubConfig,
): Promise<string[]> {
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return [];

  try {
    const tree = await fetchFileTree(owner, repo, config.token, config.host);
    return tree.filter((p) => p.endsWith(".wsdl") || p.endsWith(".xsd"));
  } catch {
    return [];
  }
}
