// ---------------------------------------------------------------------------
// Dependency modernization mapper — Feature 3 from features.md
//
// During migration analysis, evaluates the legacy project's dependencies and
// categorizes each one as:
//   • Deprecate — target stack handles this natively; dependency not needed
//   • Migrate   — modern industry-standard equivalent exists; recommend it
//   • Retain    — still valid in the target stack
//
// Supported manifest formats:
//   .NET   — packages.config, *.csproj <PackageReference>
//   Java   — pom.xml, build.gradle
//   Python — requirements.txt, pyproject.toml
//   Node   — package.json
//   Go     — go.mod
//   PHP    — composer.json
//   Ruby   — Gemfile
//   VB6    — *.vbp (component references parsed)
// ---------------------------------------------------------------------------

import { promises as fs } from "fs";
import { join, basename } from "path";
import { createProvider } from "../llm/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DepCategory = "Deprecate" | "Migrate" | "Retain";

export type DependencyEntry = {
  name: string;
  version: string;
  ecosystem: string;
  category: DepCategory;
  reason: string;
  modernEquivalent?: string;
};

export type DependencyMapResult = {
  entries: DependencyEntry[];
  ecosystem: string;
  manifestFile: string;
  outputPath: string;
};

// ---------------------------------------------------------------------------
// Manifest parsers — pure static, no LLM
// ---------------------------------------------------------------------------

function parseDotNetPackagesConfig(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  const re = /<package\s+id="([^"]+)"\s+version="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    deps.push({ name: m[1]!, version: m[2]! });
  }
  return deps;
}

function parseDotNetCsproj(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  const re = /<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    deps.push({ name: m[1]!, version: m[2]! });
  }
  // Also handle self-closing format: <PackageReference Include="..." Version="..." />
  const re2 = /<PackageReference\s+Include="([^"]+)"[^/]*\/>/gi;
  while ((m = re2.exec(content)) !== null) {
    const vMatch = m[0]!.match(/Version="([^"]+)"/i);
    if (!deps.find((d) => d.name === m![1])) {
      deps.push({ name: m[1]!, version: vMatch?.[1] ?? "?" });
    }
  }
  return deps;
}

function parsePomXml(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/gi;
  let m: RegExpExecArray | null;
  while ((m = depRe.exec(content)) !== null) {
    const block = m[1]!;
    const gid = block.match(/<groupId>([^<]+)<\/groupId>/)?.[1] ?? "";
    const aid = block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1] ?? "";
    const ver = block.match(/<version>([^<]+)<\/version>/)?.[1] ?? "?";
    const scope = block.match(/<scope>([^<]+)<\/scope>/)?.[1] ?? "";
    if (scope === "test") continue;
    if (gid && aid) deps.push({ name: `${gid}:${aid}`, version: ver });
  }
  return deps;
}

function parseBuildGradle(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  const re = /(?:implementation|compile|api|runtimeOnly)\s+['"]([^'"]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parts = m[1]!.split(":");
    if (parts.length >= 2) {
      deps.push({ name: `${parts[0]}:${parts[1]}`, version: parts[2] ?? "?" });
    }
  }
  return deps;
}

function parseRequirementsTxt(content: string): Array<{ name: string; version: string }> {
  return content.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-"))
    .map((l) => {
      const m = l.match(/^([A-Za-z0-9_.-]+)([><=!~^]+(.+))?/);
      return m ? { name: m[1]!, version: m[3]?.trim() ?? "?" } : null;
    })
    .filter((d): d is { name: string; version: string } => d !== null);
}

function parsePackageJson(content: string): Array<{ name: string; version: string }> {
  try {
    const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
      .map(([name, version]) => ({ name, version: String(version) }));
  } catch {
    return [];
  }
}

function parseGoMod(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  const re = /^\s+([^\s]+)\s+(v[^\s]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    deps.push({ name: m[1]!, version: m[2]! });
  }
  return deps;
}

function parseComposerJson(content: string): Array<{ name: string; version: string }> {
  try {
    const pkg = JSON.parse(content) as { require?: Record<string, string> };
    return Object.entries(pkg.require ?? {})
      .filter(([n]) => n !== "php")
      .map(([name, version]) => ({ name, version: String(version) }));
  } catch {
    return [];
  }
}

function parseGemfile(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  const re = /gem\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const ver = content.slice(m.index + m[0].length).match(/,\s*['"]([^'"]+)['"]/)?.[1] ?? "?";
    deps.push({ name: m[1]!, version: ver });
  }
  return deps;
}

function parseVbpFile(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  // VBP files list referenced OCX/DLL components
  const re = /^(?:Reference|Object)\s*=\s*[^#\n]*#[^#\n]*#[^#\n]*#([^#\n;]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1]!.trim().split("\\").pop()?.replace(/\.(?:ocx|dll|exe)/i, "") ?? m[1]!.trim();
    if (name) deps.push({ name, version: "VB6 COM" });
  }
  return deps;
}

// ---------------------------------------------------------------------------
// Manifest discovery
// ---------------------------------------------------------------------------

type ManifestInfo = {
  file: string;
  type: string;
  ecosystem: string;
  raw: string;
  deps: Array<{ name: string; version: string }>;
};

const MANIFEST_SPECS: Array<{
  names: string[];
  ecosystem: string;
  type: string;
  parse: (c: string) => Array<{ name: string; version: string }>;
}> = [
  { names: ["packages.config"], ecosystem: ".NET (NuGet)", type: "nuget-legacy", parse: parseDotNetPackagesConfig },
  { names: ["pom.xml"], ecosystem: "Java (Maven)", type: "maven", parse: parsePomXml },
  { names: ["requirements.txt"], ecosystem: "Python (pip)", type: "pip", parse: parseRequirementsTxt },
  { names: ["go.mod"], ecosystem: "Go (modules)", type: "gomod", parse: parseGoMod },
  { names: ["composer.json"], ecosystem: "PHP (Composer)", type: "composer", parse: parseComposerJson },
  { names: ["Gemfile"], ecosystem: "Ruby (Bundler)", type: "gemfile", parse: parseGemfile },
];

async function findManifests(repoDir: string): Promise<ManifestInfo[]> {
  const found: ManifestInfo[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "vendor") continue;
      const full = join(dir, e.name);

      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }

      // Check known manifest names
      for (const spec of MANIFEST_SPECS) {
        if (spec.names.includes(e.name)) {
          try {
            const raw = await fs.readFile(full, "utf-8");
            const deps = spec.parse(raw);
            if (deps.length > 0) {
              found.push({ file: full, type: spec.type, ecosystem: spec.ecosystem, raw, deps });
            }
          } catch { /* unreadable */ }
          break;
        }
      }

      // .csproj files
      if (e.name.endsWith(".csproj")) {
        try {
          const raw = await fs.readFile(full, "utf-8");
          const deps = parseDotNetCsproj(raw);
          if (deps.length > 0) {
            found.push({ file: full, type: "nuget-sdk", ecosystem: ".NET (NuGet)", raw, deps });
          }
        } catch { /* unreadable */ }
      }

      // build.gradle
      if (e.name === "build.gradle" || e.name === "build.gradle.kts") {
        try {
          const raw = await fs.readFile(full, "utf-8");
          const deps = parseBuildGradle(raw);
          if (deps.length > 0) {
            found.push({ file: full, type: "gradle", ecosystem: "Java (Gradle)", raw, deps });
          }
        } catch { /* unreadable */ }
      }

      // package.json (skip workspace roots with no actual deps)
      if (e.name === "package.json") {
        try {
          const raw = await fs.readFile(full, "utf-8");
          const deps = parsePackageJson(raw);
          if (deps.length > 0) {
            found.push({ file: full, type: "npm", ecosystem: "Node.js (npm)", raw, deps });
          }
        } catch { /* unreadable */ }
      }

      // .vbp files (VB6)
      if (e.name.endsWith(".vbp")) {
        try {
          const raw = await fs.readFile(full, "utf-8");
          const deps = parseVbpFile(raw);
          if (deps.length > 0) {
            found.push({ file: full, type: "vbp", ecosystem: "VB6 (COM)", raw, deps });
          }
        } catch { /* unreadable */ }
      }
    }
  }

  await walk(repoDir, 0);
  return found;
}

// ---------------------------------------------------------------------------
// LLM categorisation
// ---------------------------------------------------------------------------

const CATEGORISE_SYSTEM = `You are a dependency migration expert.
For each library listed, determine if it should be Deprecated, Migrated (with a modern alternative), or Retained in the target stack.
Respond ONLY with a valid JSON array — no markdown, no explanation, no trailing commas.`;

function buildCategorisePrompt(
  deps: Array<{ name: string; version: string }>,
  ecosystem: string,
  targetLanguage: string,
): string {
  const list = deps.slice(0, 60).map((d) => `${d.name} (${d.version})`).join("\n");
  return `Source ecosystem: ${ecosystem}
Target language: ${targetLanguage}

Dependencies to evaluate:
${list}

Return a JSON array where each object has:
{
  "name": "<exact name from above>",
  "category": "Deprecate" | "Migrate" | "Retain",
  "reason": "<one sentence>",
  "modernEquivalent": "<package@version or empty string>"
}`;
}

async function categoriseDeps(
  deps: Array<{ name: string; version: string }>,
  ecosystem: string,
  targetLanguage: string,
): Promise<DependencyEntry[]> {
  if (deps.length === 0) return [];

  const provider = await createProvider("flash");
  const prompt = buildCategorisePrompt(deps, ecosystem, targetLanguage);

  try {
    const response = await provider.chat(
      [{ role: "user", content: prompt }],
      CATEGORISE_SYSTEM,
    );
    const raw = response.trim().replace(/^```json|```$/gm, "").trim();
    const parsed = JSON.parse(raw) as Array<{
      name: string; category: DepCategory; reason: string; modernEquivalent?: string;
    }>;

    return parsed.map((p) => ({
      name: p.name,
      version: deps.find((d) => d.name === p.name)?.version ?? "?",
      ecosystem,
      category: p.category,
      reason: p.reason,
      modernEquivalent: p.modernEquivalent || undefined,
    }));
  } catch {
    // LLM failed — return all as "Retain" with unknown reason
    return deps.map((d) => ({
      name: d.name,
      version: d.version,
      ecosystem,
      category: "Retain" as DepCategory,
      reason: "Could not categorise — verify manually",
    }));
  }
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderDependencyDoc(entries: DependencyEntry[], ecosystem: string, manifestFile: string): string {
  const deprecate = entries.filter((e) => e.category === "Deprecate");
  const migrate = entries.filter((e) => e.category === "Migrate");
  const retain = entries.filter((e) => e.category === "Retain");

  const rows = (list: DependencyEntry[]) =>
    list.map((e) => {
      const equiv = e.modernEquivalent ? ` → \`${e.modernEquivalent}\`` : "";
      return `| \`${e.name}\` | ${e.version} | ${e.reason}${equiv} |`;
    }).join("\n");

  return [
    `# Dependency Modernization Map`,
    ``,
    `**Source ecosystem:** ${ecosystem}`,
    `**Manifest:** \`${basename(manifestFile)}\``,
    `**Generated by:** CCS Code migration scanner`,
    ``,
    `---`,
    ``,
    `## ✂ Deprecate (${deprecate.length})`,
    ``,
    `> Target stack handles these natively — remove from new project.`,
    ``,
    deprecate.length > 0
      ? `| Package | Version | Reason |\n|---------|---------|--------|\n${rows(deprecate)}`
      : "_None_",
    ``,
    `---`,
    ``,
    `## ↗ Migrate (${migrate.length})`,
    ``,
    `> Modern equivalents exist — replace with the recommended package.`,
    ``,
    migrate.length > 0
      ? `| Package | Version | Recommendation |\n|---------|---------|----------------|\n${rows(migrate)}`
      : "_None_",
    ``,
    `---`,
    ``,
    `## ✓ Retain (${retain.length})`,
    ``,
    `> Still valid in the target stack — keep or find near-equivalent.`,
    ``,
    retain.length > 0
      ? `| Package | Version | Notes |\n|---------|---------|-------|\n${rows(retain)}`
      : "_None_",
    ``,
    `---`,
    ``,
    `## Summary`,
    ``,
    `| Category | Count |`,
    `|----------|-------|`,
    `| Deprecate | ${deprecate.length} |`,
    `| Migrate | ${migrate.length} |`,
    `| Retain | ${retain.length} |`,
    `| **Total** | **${entries.length}** |`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function mapDependencies(
  repoDir: string,
  targetLanguage: string,
  outputDir: string,
  onProgress?: (msg: string) => void,
): Promise<DependencyMapResult | null> {
  const manifests = await findManifests(repoDir);
  if (manifests.length === 0) {
    onProgress?.("  No dependency manifests found — skipping dependency mapping.");
    return null;
  }

  // Use the first (most relevant) manifest found
  const manifest = manifests[0]!;
  onProgress?.(`  Mapping dependencies from ${basename(manifest.file)} (${manifest.ecosystem})...`);

  const entries = await categoriseDeps(manifest.deps, manifest.ecosystem, targetLanguage);

  const doc = renderDependencyDoc(entries, manifest.ecosystem, manifest.file);
  const outputPath = join(outputDir, "dependencies.md");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, doc, "utf-8");

  onProgress?.(`  Dependency map: ${entries.filter((e) => e.category === "Migrate").length} to migrate, ${entries.filter((e) => e.category === "Deprecate").length} to deprecate`);

  return {
    entries,
    ecosystem: manifest.ecosystem,
    manifestFile: manifest.file,
    outputPath,
  };
}

export function formatDepSummary(result: DependencyMapResult): string {
  const m = result.entries.filter((e) => e.category === "Migrate").length;
  const d = result.entries.filter((e) => e.category === "Deprecate").length;
  const r = result.entries.filter((e) => e.category === "Retain").length;
  return `Dependencies (${result.ecosystem}): ${m} migrate, ${d} deprecate, ${r} retain → \`${result.outputPath}\``;
}
