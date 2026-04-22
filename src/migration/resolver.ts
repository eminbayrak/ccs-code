import { searchOrgCode, fetchFileTree, parseRepoUrl } from "../connectors/github.js";
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

// File extensions that could contain a SOAP service implementation
const SERVICE_EXTENSIONS = [".cs", ".asmx", ".java", ".vb", ".cpp", ".py"];

// Naming patterns to check for a given namespace (e.g. "FooManager")
function candidateFilenames(namespace: string): string[] {
  return [
    `${namespace}.cs`,
    `${namespace}Service.cs`,
    `I${namespace}.cs`,
    `${namespace}Impl.cs`,
    `${namespace}.asmx`,
    `${namespace}.asmx.cs`,
    `${namespace}.java`,
    `${namespace}ServiceImpl.java`,
    `${namespace}.vb`,
  ];
}

// ---------------------------------------------------------------------------
// Rank candidates using Haiku when there are multiple matches
// ---------------------------------------------------------------------------

async function rankCandidates(
  provider: LLMProvider,
  namespace: string,
  candidates: ResolvedService[]
): Promise<ResolvedService> {
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.repoFullName}/${c.filePath}`)
    .join("\n");

  const response = await provider.chat(
    [
      {
        role: "user",
        content: `You are resolving a SOAP service namespace to the correct source file.

Namespace to find: "${namespace}"

Candidates:
${list}

Which candidate (number) is most likely the main implementation file for "${namespace}"?
Prefer files that: match the exact name, are in a "Services" or "Implementations" folder, are .cs or .asmx files.
Avoid interfaces (prefixed with "I"), test files, and mock files.

Respond with ONLY a JSON object: {"choice": <number 1-${candidates.length}>}`,
      },
    ],
    "You resolve service names to source files. Respond only with valid JSON."
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
// Main resolver
// ---------------------------------------------------------------------------

export async function resolveNamespace(
  namespace: string,
  config: GithubConfig,
  haikuProvider: LLMProvider
): Promise<ResolvedService | null> {
  const candidates: ResolvedService[] = [];

  // Strategy 1: search for exact filename matches
  for (const filename of candidateFilenames(namespace)) {
    const ext = filename.slice(filename.lastIndexOf("."));
    if (!SERVICE_EXTENSIONS.includes(ext)) continue;

    try {
      const results = await searchOrgCode(
        config.org,
        `filename:${filename}`,
        config.token,
        config.host
      );
      for (const r of results) {
        // Exclude test and mock files
        if (/test|mock|spec|stub/i.test(r.filePath)) continue;
        candidates.push({ ...r, confidence: "exact" });
      }
    } catch {
      // search API may fail — continue
    }
  }

  // Strategy 2: search for the namespace string in code
  if (candidates.length === 0) {
    try {
      const results = await searchOrgCode(
        config.org,
        `"${namespace}"`,
        config.token,
        config.host
      );
      for (const r of results) {
        if (/test|mock|spec|stub/i.test(r.filePath)) continue;
        const ext = r.filePath.slice(r.filePath.lastIndexOf("."));
        if (!SERVICE_EXTENSIONS.includes(ext)) continue;
        candidates.push({ ...r, confidence: "likely" });
      }
    } catch {
      // ignore
    }
  }

  if (candidates.length === 0) return null;

  // Deduplicate by filePath
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.repoFullName}/${c.filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 1) return unique[0] ?? null;

  // Multiple candidates — ask Haiku to rank
  const best = await rankCandidates(haikuProvider, namespace, unique);
  return { ...best, confidence: "ambiguous" };
}

// ---------------------------------------------------------------------------
// Find WSDL files in a resolved service repo
// ---------------------------------------------------------------------------

export async function findWsdlFiles(
  repoFullName: string,
  config: GithubConfig
): Promise<string[]> {
  const parsed = { owner: repoFullName.split("/")[0], repo: repoFullName.split("/")[1] };
  if (!parsed.owner || !parsed.repo) return [];

  try {
    const tree = await fetchFileTree(parsed.owner, parsed.repo, config.token, config.host);
    return tree.filter((p) => p.endsWith(".wsdl") || p.endsWith(".xsd"));
  } catch {
    return [];
  }
}
