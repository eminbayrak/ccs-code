import {
  searchOrgCode,
  fetchFileTree,
  fetchFileContent,
  parseRepoUrl,
} from "../connectors/github.js";
import type { LLMProvider } from "../llm/providers/base.js";
import type { ToolDefinition, ToolCall } from "../llm/providers/base.js";

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
// AI-agent-driven resolver
// The model is given real GitHub tools and decides how to search for the service.
// It can make multiple calls (search → read file to confirm → decide) before
// returning its final answer. This is far more accurate than hardcoded strategies.
// ---------------------------------------------------------------------------

async function resolveWithAgentTools(
  namespace: string,
  config: GithubConfig,
  provider: LLMProvider,
  entryRepoUrl?: string,
  onProgress?: (msg: string) => void,
): Promise<ResolvedService | null> {
  if (!provider.chatWithTools) return null;

  const host = config.host ?? "github.com";

  const tools: ToolDefinition[] = [
    {
      name: "search_github",
      description: `Search for code across GitHub repositories in the '${config.org}' organization. Returns a list of matching files with their repo name and path. Use specific queries first (e.g. filename:CustomerManager.cls), then broader ones if needed.`,
      parameters: [
        {
          name: "query",
          type: "string",
          description: "GitHub code search query. Examples: 'filename:CustomerManager.cls', 'CustomerManager Class', 'CustomerManager serviceNamespace'",
          required: true,
        },
      ],
    },
    {
      name: "list_repo_files",
      description: "List all files in a GitHub repository. Use this to understand a repo's structure when you have a candidate repo but aren't sure which file is the implementation.",
      parameters: [
        { name: "owner", type: "string", description: "GitHub username or organization name", required: true },
        { name: "repo", type: "string", description: "Repository name", required: true },
      ],
    },
    {
      name: "read_file",
      description: "Read the content of a specific file from GitHub to verify it contains the service implementation you are looking for.",
      parameters: [
        { name: "owner", type: "string", description: "GitHub username or organization name", required: true },
        { name: "repo", type: "string", description: "Repository name", required: true },
        { name: "path", type: "string", description: "File path within the repository (e.g. 'Services/CustomerManager.cls')", required: true },
      ],
    },
  ];

  const executeToolCall = async (call: ToolCall): Promise<string> => {
    try {
      if (call.name === "search_github") {
        const query = call.input.query as string;
        onProgress?.(`Searching: ${query}`);
        const results = await searchOrgCode(config.org, query, config.token, config.host);
        if (results.length === 0) {
          onProgress?.(`  → No results`);
          return "No results found for this query.";
        }
        onProgress?.(`  → Found ${results.length} candidate${results.length === 1 ? "" : "s"}`);
        return results.slice(0, 10).map((r) => `${r.repoFullName} — ${r.filePath}`).join("\n");
      }

      if (call.name === "list_repo_files") {
        const owner = call.input.owner as string;
        const repo = call.input.repo as string;
        onProgress?.(`Listing: ${owner}/${repo}`);
        const tree = await fetchFileTree(owner, repo, config.token, config.host);
        if (tree.length === 0) return "Repository is empty or inaccessible.";
        return tree.slice(0, 150).join("\n");
      }

      if (call.name === "read_file") {
        const owner = call.input.owner as string;
        const repo = call.input.repo as string;
        const path = call.input.path as string;
        const filename = path.split("/").pop() ?? path;
        onProgress?.(`Verifying: ${filename}`);
        const content = await fetchFileContent(owner, repo, path, config.token, config.host);
        return content.length > 4000 ? content.slice(0, 4000) + "\n... [truncated]" : content;
      }

      return `Unknown tool: ${call.name}`;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      onProgress?.(`  ✗ ${errMsg}`);
      return `Error: ${errMsg}`;
    }
  };

  const entryContext = entryRepoUrl
    ? `\nThis service was called from: ${entryRepoUrl}. It may live in the same org but a different repo.`
    : "";

  const systemPrompt =
    "You are a research agent that finds GitHub repositories for SOAP/WCF service implementations. " +
    "Use the tools to search GitHub, then verify by reading file content if needed. " +
    "When confident, respond with ONLY a valid JSON object — no markdown, no explanation, just the JSON.";

  const userMessage =
    `Find the GitHub repository and source file that implements the SOAP service named "${namespace}".` +
    `\n\nOrganization to search: "${config.org}"${entryContext}` +
    `\n\nThis is a legacy SOAP/WCF/COM service. Common file patterns:` +
    `\n- ${namespace}.cs, ${namespace}.vb, ${namespace}.cls (VB6 Class Module)` +
    `\n- ${namespace}Service.cs, ${namespace}Manager.cs, ${namespace}Impl.java` +
    `\n- I${namespace}.cs (interface — avoid this, find the implementation)` +
    `\n\nSearch strategy: start specific (exact filename), broaden if no results.` +
    `\nAvoid test files, mock files, and interfaces.` +
    `\n\nWhen you have found the correct file, respond with ONLY this JSON:` +
    `\n{"repoFullName":"owner/repo","filePath":"path/to/file","confidence":"exact"|"likely"|"ambiguous"}` +
    `\n\nIf you cannot find it after searching, respond with:` +
    `\n{"repoFullName":null,"filePath":null,"confidence":"none"}`;

  const response = await provider.chatWithTools(
    [{ role: "user", content: userMessage }],
    tools,
    executeToolCall,
    systemPrompt,
  );

  try {
    const match = response.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      repoFullName: string | null;
      filePath: string | null;
      confidence: string;
    };
    if (!parsed.repoFullName || !parsed.filePath) return null;
    return {
      repoFullName: parsed.repoFullName,
      filePath: parsed.filePath,
      htmlUrl: `https://${host}/${parsed.repoFullName}/blob/main/${parsed.filePath}`,
      confidence: (["exact", "likely", "ambiguous"].includes(parsed.confidence)
        ? parsed.confidence
        : "likely") as "exact" | "likely" | "ambiguous",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sequential fallback — used when the provider does not support chatWithTools
// ---------------------------------------------------------------------------

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
    `${namespace}.cls`,
    `${namespace}.bas`,
  ];
}

function deduplicate(candidates: ResolvedService[]): ResolvedService[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.repoFullName}/${c.filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
        content: `Which of these files is most likely the main implementation of the "${namespace}" SOAP service?\n\n${list}\n\nRespond ONLY with JSON: {"choice": <number>}`,
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

async function resolveSequential(
  namespace: string,
  config: GithubConfig,
  provider: LLMProvider,
  entryRepoUrl?: string,
  methodName?: string,
): Promise<ResolvedService | null> {
  const host = config.host ?? "github.com";
  const candidates: ResolvedService[] = [];
  const entryParsed = entryRepoUrl ? parseRepoUrl(entryRepoUrl) : null;
  const entryRepoName = entryParsed ? `${entryParsed.owner}/${entryParsed.repo}` : null;

  // Strategy 1 — exact filename search
  for (const filename of candidateFilenames(namespace)) {
    const ext = filename.slice(filename.lastIndexOf("."));
    if (!SERVICE_EXTENSIONS.includes(ext)) continue;
    try {
      const results = await searchOrgCode(config.org, `filename:${filename}`, config.token, config.host);
      for (const r of results) {
        if (/test|mock|spec|stub/i.test(r.filePath)) continue;
        candidates.push({ ...r, confidence: "exact" });
      }
    } catch { /* continue */ }
  }

  // Strategy 2 — namespace string search
  if (candidates.length === 0) {
    try {
      const results = await searchOrgCode(config.org, `"${namespace}"`, config.token, config.host);
      for (const r of results) {
        if (/test|mock|spec|stub/i.test(r.filePath)) continue;
        const ext = r.filePath.slice(r.filePath.lastIndexOf("."));
        if (!SERVICE_EXTENSIONS.includes(ext)) continue;
        candidates.push({ ...r, confidence: "likely" });
      }
    } catch { /* ignore */ }
  }

  // Strategy 3 — method name search
  if (candidates.length === 0 && methodName && methodName !== "unknown") {
    try {
      const results = await searchOrgCode(config.org, `"${methodName}"`, config.token, config.host);
      for (const r of results) {
        if (/test|mock|spec|stub/i.test(r.filePath)) continue;
        const ext = r.filePath.slice(r.filePath.lastIndexOf("."));
        if (!SERVICE_EXTENSIONS.includes(ext)) continue;
        candidates.push({ ...r, confidence: "ambiguous" });
      }
    } catch { /* ignore */ }
  }

  if (candidates.length === 0) return null;

  // Prefer entry repo matches
  if (entryRepoName) {
    const entryMatches = deduplicate(candidates.filter((c) => c.repoFullName === entryRepoName));
    if (entryMatches.length === 1) return entryMatches[0] ?? null;
    if (entryMatches.length > 1) return rankCandidates(provider, namespace, entryMatches);
  }

  const unique = deduplicate(candidates);
  if (unique.length === 1) return unique[0] ?? null;
  return rankCandidates(provider, namespace, unique);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function resolveNamespace(
  namespace: string,
  config: GithubConfig,
  provider: LLMProvider,
  entryRepoUrl?: string,
  methodName?: string,
  onProgress?: (msg: string) => void,
): Promise<ResolvedService | null> {
  // Use AI-agent tool research if the provider supports it
  if (provider.chatWithTools) {
    const result = await resolveWithAgentTools(namespace, config, provider, entryRepoUrl, onProgress);
    if (result) return result;
    return null;
  }

  // Fallback: hardcoded sequential search + LLM ranking
  return resolveSequential(namespace, config, provider, entryRepoUrl, methodName);
}

// ---------------------------------------------------------------------------
// Find WSDL files in a resolved service repo
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
