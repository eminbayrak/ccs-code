import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { z } from "zod";
import type { ConnectorAdapter } from "./base.js";
import type { ToolDescriptor } from "../capabilities/types.js";

// ---------------------------------------------------------------------------
// Vault sync helpers (CCS Code)
// ---------------------------------------------------------------------------

export type GitHubSyncConfig = {
    repos: string[];
    include: Array<"commits" | "prs" | "issues" | "readme" | "file_tree">;
    token?: string;
};

// ---------------------------------------------------------------------------
// GitHub API utilities — shared by vault sync and migration modules
// ---------------------------------------------------------------------------

export function resolveToken(token?: string): string | undefined {
    return token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.CCS_GITHUB_TOKEN ?? process.env.GITHUB_PRIVATE_TOKEN;
}

function ghHeaders(token?: string): Record<string, string> {
    const h: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "CCS-Code/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    const t = resolveToken(token);
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
}

/** Build the API base URL — supports GitHub Enterprise Server */
export function buildApiBase(host?: string): string {
    if (!host || host === "github.com") return "https://api.github.com";
    return `https://${host}/api/v3`;
}

/** Helper to wrap fetch with a timeout using AbortController */
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return res;
    } catch (e) {
        clearTimeout(timer);
        if (e instanceof Error && e.name === "AbortError") {
            throw new Error(`GitHub request timed out after ${timeoutMs / 1000}s: ${url}`);
        }
        throw e;
    }
}


// ---------------------------------------------------------------------------
// gh CLI integration — preferred over HTTP when available (no rate limit issues)
// ---------------------------------------------------------------------------

let _hasGhCli: boolean | null = null;

export function hasGhCliAvailable(): boolean { return hasGhCli(); }

// ---------------------------------------------------------------------------
// Rate limit check — call this before a scan to surface warnings early
// ---------------------------------------------------------------------------

export type RateLimitInfo = {
  remaining: number;
  limit: number;
  resetAt: Date;
  resetInMinutes: number;
  isExhausted: boolean;
};

export function checkRateLimit(): RateLimitInfo | null {
  try {
    const raw = execFileSync("gh", ["api", "/rate_limit", "--jq", ".resources.core"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).toString();
    const data = JSON.parse(raw) as { remaining: number; limit: number; reset: number };
    const resetAt = new Date(data.reset * 1000);
    const resetInMinutes = Math.ceil((resetAt.getTime() - Date.now()) / 60_000);
    return {
      remaining: data.remaining,
      limit: data.limit,
      resetAt,
      resetInMinutes,
      isExhausted: data.remaining === 0,
    };
  } catch {
    // gh CLI not available or quota check failed — not critical
    return null;
  }
}

function hasGhCli(): boolean {
    if (_hasGhCli !== null) return _hasGhCli;
    try {
        // Use `gh auth token` — exits 0 if any token is available (env var or keyring)
        // `gh auth status` exits 1 when keyring is broken even if a token exists
        execFileSync("gh", ["auth", "token"], { stdio: "ignore" });
        _hasGhCli = true;
    } catch {
        _hasGhCli = false;
    }
    return _hasGhCli;
}

/**
 * Fetch a GitHub API path via the `gh` CLI.
 * The CLI handles auth automatically and uses the OAuth token (higher rate limits).
 * IMPORTANT: preserve the full path including query string (e.g. ?recursive=1).
 */
function fetchWithGhCli<T>(url: string): T {
    // Extract path+query from full URL or use as-is if already a path
    let apiPath: string;
    try {
        const u = new URL(url);
        apiPath = u.pathname + u.search; // preserve ?recursive=1 etc.
    } catch {
        apiPath = url.startsWith("/") ? url : `/${url}`;
    }
    const output = execFileSync("gh", ["api", apiPath], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
    }).toString();
    return JSON.parse(output) as T;
}

/** Fetch with gh CLI preferred, HTTP as fallback with exponential backoff */
async function ghFetchWithRetry<T>(
    url: string,
    token?: string,
    maxRetries = 2
): Promise<T> {
    // Prefer gh CLI — it uses OAuth and has much higher rate limits
    if (hasGhCli()) {
        try {
            return fetchWithGhCli<T>(url);
        } catch (cliErr) {
            // Only fall through if CLI itself failed (not a 404/auth error worth reporting)
            const msg = cliErr instanceof Error ? cliErr.message : String(cliErr);
            if (msg.includes("HTTP 404") || msg.includes("Not Found")) {
                throw new Error(`Repository or resource not found: ${url}`);
            }
            // CLI failed for other reason — try HTTP
        }
    }

    // HTTP fallback
    let attempt = 0;
    while (true) {
        const res = await fetchWithTimeout(url, { headers: ghHeaders(token) }, 20_000);

        if (res.ok) return res.json() as Promise<T>;

        const body = await res.text();

        if (res.status === 429 || res.status === 403) {
            const retryAfter = res.headers.get("Retry-After");
            const resetAt = res.headers.get("X-RateLimit-Reset");

            if (retryAfter || resetAt) {
                const waitMs = retryAfter
                    ? parseInt(retryAfter, 10) * 1000
                    : Math.max(0, parseInt(resetAt!, 10) * 1000 - Date.now()) + 1000;
                const cappedWait = Math.min(waitMs, 10_000);
                if (attempt < maxRetries) {
                    await new Promise((r) => setTimeout(r, cappedWait));
                    attempt++;
                    continue;
                }
            }
            if (res.status === 403) {
                throw new Error(`GitHub 403. Install gh CLI (brew install gh && gh auth login) or set GITHUB_TOKEN in .env. Detail: ${body.slice(0, 100)}`);
            }
            throw new Error(`GitHub rate limited. Install gh CLI (brew install gh && gh auth login) for unlimited access. ${body.slice(0, 100)}`);
        }

        if (res.status >= 500 && attempt < maxRetries) {
            const wait = Math.min(1000 * 2 ** attempt, 5_000);
            await new Promise((r) => setTimeout(r, wait));
            attempt++;
            continue;
        }

        throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
    }
}

async function ghFetch<T>(path: string, token?: string, host?: string): Promise<T> {
    const base = buildApiBase(host);
    return ghFetchWithRetry<T>(`${base}${path}`, token);
}

// ---------------------------------------------------------------------------
// Migration helpers — fetch file content and file tree
// ---------------------------------------------------------------------------

/** Fetch the raw text content of a single file from a GitHub repo */
export async function fetchFileContent(
    owner: string,
    repo: string,
    path: string,
    token?: string,
    host?: string
): Promise<string> {
    const data = await ghFetch<{ content: string; encoding: string }>(
        `/repos/${owner}/${repo}/contents/${path}`,
        token,
        host
    );
    if (data.encoding === "base64") {
        return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
    }
    return data.content;
}

/** Fetch the full recursive file tree for a repo — returns all file paths */
export async function fetchFileTree(
    owner: string,
    repo: string,
    token?: string,
    host?: string,
    branch = "HEAD"
): Promise<string[]> {
    const data = await ghFetch<{ tree: Array<{ path: string; type: string }> }>(
        `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        token,
        host
    );
    return data.tree.filter((n) => n.type === "blob").map((n) => n.path);
}

/** Fetch the repository default branch for stable source links */
export async function fetchDefaultBranch(
    owner: string,
    repo: string,
    token?: string,
    host?: string
): Promise<string> {
    const data = await ghFetch<{ default_branch?: string }>(
        `/repos/${owner}/${repo}`,
        token,
        host
    );
    return data.default_branch || "HEAD";
}

/** Search code across the org — returns matches with repo and file path */
export async function searchOrgCode(
    org: string,
    query: string,
    token?: string,
    host?: string
): Promise<Array<{ repoFullName: string; filePath: string; htmlUrl: string }>> {
    const encoded = encodeURIComponent(`${query} org:${org}`);
    const data = await ghFetch<{
        items: Array<{ repository: { full_name: string }; path: string; html_url: string }>;
    }>(`/search/code?q=${encoded}&per_page=10`, token, host);

    return data.items.map((item) => ({
        repoFullName: item.repository.full_name,
        filePath: item.path,
        htmlUrl: item.html_url,
    }));
}

/** Parse owner/repo from a full GitHub URL */
export function parseRepoUrl(url: string): { host: string; owner: string; repo: string } | null {
    try {
        const u = new URL(url);
        const parts = u.pathname.replace(/^\//, "").split("/");
        if (parts.length < 2) return null;
        const owner = parts[0] ?? "";
        let repo = parts[1] ?? "";
        if (repo.endsWith(".git")) repo = repo.slice(0, -4);
        return { host: u.host, owner, repo };
    } catch {
        return null;
    }
}

export async function syncRepo(repo: string, rawDir: string, cfg: GitHubSyncConfig): Promise<string[]> {
    const repoDir = join(rawDir, "github", repo.replace("/", "__"));
    await fs.mkdir(repoDir, { recursive: true });
    const written: string[] = [];
    const token = cfg.token;

    if (cfg.include.includes("readme")) {
        try {
            const data = await ghFetch<{ content: string; encoding: string }>(`/repos/${repo}/readme`, token);
            const content = data.encoding === "base64"
                ? Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8")
                : data.content;
            const p = join(repoDir, "README.md");
            await fs.writeFile(p, content, "utf-8");
            written.push(p);
        } catch { /* no readme */ }
    }

    if (cfg.include.includes("issues")) {
        try {
            const issues = await ghFetch<Array<{ number: number; title: string; body: string | null; state: string; labels: Array<{ name: string }>; assignees: Array<{ login: string }>; created_at: string }>>(`/repos/${repo}/issues?state=open&per_page=50`, token);
            const lines = [`# Open Issues — ${repo}`, `_Fetched: ${new Date().toISOString()}_`, ""];
            for (const i of issues) {
                lines.push(`## #${i.number}: ${i.title}`, `- State: ${i.state}`, `- Labels: ${i.labels.map((l) => l.name).join(", ") || "none"}`, `- Assignees: ${i.assignees.map((a) => a.login).join(", ") || "none"}`, "", i.body?.slice(0, 500) ?? "_No body_", "", "---", "");
            }
            const p = join(repoDir, "issues.md");
            await fs.writeFile(p, lines.join("\n"), "utf-8");
            written.push(p);
        } catch { /* unavailable */ }
    }

    if (cfg.include.includes("prs")) {
        try {
            const prs = await ghFetch<Array<{ number: number; title: string; body: string | null; user: { login: string }; created_at: string; head: { ref: string } }>>(`/repos/${repo}/pulls?state=open&per_page=30`, token);
            const lines = [`# Open Pull Requests — ${repo}`, `_Fetched: ${new Date().toISOString()}_`, ""];
            for (const pr of prs) {
                lines.push(`## PR #${pr.number}: ${pr.title}`, `- Author: @${pr.user.login}`, `- Branch: ${pr.head.ref}`, `- Created: ${pr.created_at}`, "", pr.body?.slice(0, 500) ?? "_No description_", "", "---", "");
            }
            const p = join(repoDir, "pull-requests.md");
            await fs.writeFile(p, lines.join("\n"), "utf-8");
            written.push(p);
        } catch { /* unavailable */ }
    }

    if (cfg.include.includes("commits")) {
        try {
            const commits = await ghFetch<Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>>(`/repos/${repo}/commits?per_page=30`, token);
            const lines = [`# Recent Commits — ${repo}`, `_Fetched: ${new Date().toISOString()}_`, ""];
            for (const c of commits) {
                lines.push(`- \`${c.sha.slice(0, 8)}\` ${c.commit.message.split("\n")[0]} — _${c.commit.author.name}_ (${c.commit.author.date})`);
            }
            const p = join(repoDir, "commits.md");
            await fs.writeFile(p, lines.join("\n"), "utf-8");
            written.push(p);
        } catch { /* unavailable */ }
    }

    if (cfg.include.includes("file_tree")) {
        try {
            const tree = await ghFetch<{ tree: Array<{ path: string; type: string }> }>(`/repos/${repo}/git/trees/HEAD?recursive=1`, token);
            const paths = tree.tree.filter((n) => n.type === "blob").map((n) => n.path).slice(0, 500);
            const lines = [`# File Tree — ${repo}`, `_Fetched: ${new Date().toISOString()}_`, "", "```", ...paths, "```"];
            const p = join(repoDir, "file-tree.md");
            await fs.writeFile(p, lines.join("\n"), "utf-8");
            written.push(p);
        } catch { /* unavailable */ }
    }

    return written;
}

const syncRepoInputSchema = z.object({
    repo: z.string().describe("Repository in org/name format"),
    rawDir: z.string().describe("Path to the vault raw/ directory"),
    include: z.array(z.enum(["commits", "prs", "issues", "readme", "file_tree"])).default(["commits", "prs", "issues", "readme"]),
});

const searchCodeInputSchema = z.object({
    query: z.string().min(1),
});

const listPullRequestsInputSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    state: z.enum(["open", "closed", "all"]).default("open"),
    perPage: z.number().int().positive().max(100).default(10),
});

const summarizeOrgReposInputSchema = z.object({
    org: z.string().min(1),
    maxRepos: z.number().int().positive().max(1000).default(200),
    includeArchived: z.boolean().default(false),
});

export const githubConnector: ConnectorAdapter = {
    name: "github",
    getTools() {
        const tools: ToolDescriptor[] = [
            {
                id: "github.sync_repo",
                name: "github_sync_repo",
                kind: "tool",
                description: "Sync a GitHub repository into the CCS Code vault raw/ directory (commits, PRs, issues, README, file tree).",
                riskClass: "read",
                inputSchema: syncRepoInputSchema,
                async handler(input) {
                    const parsed = syncRepoInputSchema.safeParse(input);
                    if (!parsed.success) return { status: "error", error: parsed.error.message };
                    const { repo, rawDir, include } = parsed.data;
                    try {
                        const written = await syncRepo(repo, rawDir, { repos: [repo], include });
                        return { status: "success", output: { repo, filesWritten: written.length, paths: written } };
                    } catch (e) {
                        return { status: "error", error: e instanceof Error ? e.message : String(e) };
                    }
                },
            },
            {
                id: "github.search_code",
                name: "github_search_code",
                kind: "tool",
                description: "Search code in GitHub using the authenticated user token.",
                riskClass: "read",
                inputSchema: searchCodeInputSchema,
                async handler(input) {
                    const parsed = searchCodeInputSchema.safeParse(input);
                    if (!parsed.success) {
                        return { status: "error", error: parsed.error.message };
                    }

                    const token = process.env.CCS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PRIVATE_TOKEN;
                    if (!token) {
                        return {
                            status: "error",
                            error: "Missing GitHub token (CCS_GITHUB_TOKEN, GITHUB_TOKEN, or GITHUB_PRIVATE_TOKEN) in environment.",
                        };
                    }

                    const url = new URL("https://api.github.com/search/code");
                    url.searchParams.set("q", parsed.data.query);
                    url.searchParams.set("per_page", "5");

                    const response = await fetch(url, {
                        headers: {
                            Accept: "application/vnd.github+json",
                            Authorization: `Bearer ${token}`,
                            "X-GitHub-Api-Version": "2022-11-28",
                        },
                    });

                    if (!response.ok) {
                        const text = await response.text();
                        return {
                            status: "error",
                            error: `GitHub search failed (${response.status}): ${text}`,
                        };
                    }

                    const json = await response.json();
                    return {
                        status: "success",
                        output: json,
                    };
                },
            },
            {
                id: "github.list_pull_requests",
                name: "github_list_pull_requests",
                kind: "tool",
                description: "List pull requests for a GitHub repository.",
                riskClass: "read",
                inputSchema: listPullRequestsInputSchema,
                async handler(input) {
                    const parsed = listPullRequestsInputSchema.safeParse(input);
                    if (!parsed.success) {
                        return { status: "error", error: parsed.error.message };
                    }

                    const token = process.env.CCS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PRIVATE_TOKEN;
                    if (!token) {
                        return {
                            status: "error",
                            error: "Missing GitHub token (CCS_GITHUB_TOKEN, GITHUB_TOKEN, or GITHUB_PRIVATE_TOKEN) in environment.",
                        };
                    }

                    const { owner, repo, state, perPage } = parsed.data;
                    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/pulls`);
                    url.searchParams.set("state", state);
                    url.searchParams.set("per_page", String(perPage));

                    const response = await fetch(url, {
                        headers: {
                            Accept: "application/vnd.github+json",
                            Authorization: `Bearer ${token}`,
                            "X-GitHub-Api-Version": "2022-11-28",
                        },
                    });

                    if (!response.ok) {
                        const text = await response.text();
                        return {
                            status: "error",
                            error: `GitHub pull request list failed (${response.status}): ${text}`,
                        };
                    }

                    const json = await response.json();
                    return {
                        status: "success",
                        output: json,
                    };
                },
            },
            {
                id: "github.summarize_org_repos",
                name: "github_summarize_org_repos",
                kind: "tool",
                description:
                    "Scan repositories in a GitHub organization and return an aggregated portfolio summary.",
                riskClass: "read",
                inputSchema: summarizeOrgReposInputSchema,
                async handler(input) {
                    const parsed = summarizeOrgReposInputSchema.safeParse(input);
                    if (!parsed.success) {
                        return { status: "error", error: parsed.error.message };
                    }

                    const token = process.env.CCS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PRIVATE_TOKEN;
                    if (!token) {
                        return {
                            status: "error",
                            error: "Missing GitHub token (CCS_GITHUB_TOKEN, GITHUB_TOKEN, or GITHUB_PRIVATE_TOKEN) in environment.",
                        };
                    }

                    const headers = {
                        Accept: "application/vnd.github+json",
                        Authorization: `Bearer ${token}`,
                        "X-GitHub-Api-Version": "2022-11-28",
                    };

                    const { org, maxRepos, includeArchived } = parsed.data;
                    const repos: any[] = [];
                    let page = 1;
                    const perPage = 100;

                    while (repos.length < maxRepos) {
                        const url = new URL(`https://api.github.com/orgs/${org}/repos`);
                        url.searchParams.set("type", "all");
                        url.searchParams.set("sort", "updated");
                        url.searchParams.set("direction", "desc");
                        url.searchParams.set("per_page", String(perPage));
                        url.searchParams.set("page", String(page));

                        const response = await fetch(url, { headers });
                        if (!response.ok) {
                            const text = await response.text();
                            return {
                                status: "error",
                                error: `GitHub org repo scan failed (${response.status}): ${text}`,
                            };
                        }

                        const batch = await response.json();
                        if (!Array.isArray(batch) || batch.length === 0) {
                            break;
                        }

                        repos.push(...batch);
                        if (batch.length < perPage) {
                            break;
                        }
                        page += 1;
                    }

                    const limitedRepos = repos.slice(0, maxRepos);
                    const filteredRepos = includeArchived
                        ? limitedRepos
                        : limitedRepos.filter((repo) => !repo.archived);

                    const languageCounts: Record<string, number> = {};
                    const topicCounts: Record<string, number> = {};
                    const visibilityCounts: Record<string, number> = {};

                    for (const repo of filteredRepos) {
                        const language = repo.language || "Unknown";
                        languageCounts[language] = (languageCounts[language] ?? 0) + 1;

                        const visibility = repo.visibility || (repo.private ? "private" : "public");
                        visibilityCounts[visibility] = (visibilityCounts[visibility] ?? 0) + 1;

                        for (const topic of repo.topics || []) {
                            topicCounts[topic] = (topicCounts[topic] ?? 0) + 1;
                        }
                    }

                    const topLanguages = Object.entries(languageCounts)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10)
                        .map(([name, count]) => ({ name, count }));

                    const topTopics = Object.entries(topicCounts)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 15)
                        .map(([name, count]) => ({ name, count }));

                    const normalizedRepos = filteredRepos.map((repo) => ({
                        name: repo.name,
                        fullName: repo.full_name,
                        private: Boolean(repo.private),
                        visibility: repo.visibility || (repo.private ? "private" : "public"),
                        archived: Boolean(repo.archived),
                        fork: Boolean(repo.fork),
                        language: repo.language || "Unknown",
                        topics: Array.isArray(repo.topics) ? repo.topics : [],
                        description: repo.description || "",
                        defaultBranch: repo.default_branch,
                        stars: Number(repo.stargazers_count ?? 0),
                        forks: Number(repo.forks_count ?? 0),
                        openIssues: Number(repo.open_issues_count ?? 0),
                        updatedAt: repo.updated_at,
                        pushedAt: repo.pushed_at,
                        url: repo.html_url,
                    }));

                    const now = new Date();
                    const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;
                    const activeLast30d = normalizedRepos.filter((repo) => {
                        if (!repo.pushedAt) return false;
                        const pushedAt = new Date(repo.pushedAt).getTime();
                        return Number.isFinite(pushedAt) && pushedAt >= thirtyDaysAgo;
                    }).length;

                    return {
                        status: "success",
                        output: {
                            organization: org,
                            scannedAt: now.toISOString(),
                            scanLimits: {
                                maxRepos,
                                includeArchived,
                            },
                            totals: {
                                reposReturnedByApi: repos.length,
                                reposAnalyzed: normalizedRepos.length,
                                activeLast30d,
                                archived: normalizedRepos.filter((repo) => repo.archived).length,
                                forks: normalizedRepos.filter((repo) => repo.fork).length,
                            },
                            visibility: visibilityCounts,
                            topLanguages,
                            topTopics,
                            repos: normalizedRepos,
                        },
                    };
                },
            },
        ];

        return tools;
    },
};
