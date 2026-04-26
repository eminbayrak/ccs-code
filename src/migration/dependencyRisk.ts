import { promises as fs } from "node:fs";
import type { ComponentAnalysis, FrameworkInfo } from "./rewriteTypes.js";
import type { RunLayout } from "./runLayout.js";

export type DependencyRecord = {
  ecosystem: "npm" | "nuget" | "maven" | "python" | "go" | "unknown";
  name: string;
  version: string;
  scope: "runtime" | "development" | "optional" | "peer" | "unknown";
  manifestPath: string;
};

export type DependencyRiskFinding = {
  severity: "high" | "medium" | "low" | "info";
  category: "lockfile" | "version_policy" | "security_sensitive" | "migration_planning" | "inventory";
  packageName?: string;
  message: string;
  recommendation: string;
};

export type DependencyRiskReport = {
  generatedAt: string;
  frameworkInfo: FrameworkInfo;
  manifests: string[];
  dependencies: DependencyRecord[];
  findings: DependencyRiskFinding[];
  componentExternalDependencies: Record<string, string[]>;
};

export const SECURITY_MANIFEST_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  /(^|\/)[^/]+\.csproj$/,
  /(^|\/)packages\.lock\.json$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)(build\.gradle|build\.gradle\.kts|gradle\.lockfile)$/,
  /(^|\/)(requirements\.txt|requirements-dev\.txt|pyproject\.toml|Pipfile|Pipfile\.lock|poetry\.lock)$/,
  /(^|\/)(go\.mod|go\.sum)$/,
];

export function isSecurityManifest(path: string): boolean {
  return SECURITY_MANIFEST_PATTERNS.some((pattern) => pattern.test(path));
}

function parseNpmPackageJson(path: string, content: string): DependencyRecord[] {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    const sections: Array<[string, DependencyRecord["scope"]]> = [
      ["dependencies", "runtime"],
      ["devDependencies", "development"],
      ["optionalDependencies", "optional"],
      ["peerDependencies", "peer"],
    ];
    const records: DependencyRecord[] = [];
    for (const [section, scope] of sections) {
      const deps = json[section];
      if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
      for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
        records.push({
          ecosystem: "npm",
          name,
          version: typeof version === "string" ? version : "unknown",
          scope,
          manifestPath: path,
        });
      }
    }
    return records;
  } catch {
    return [];
  }
}

function parseCsproj(path: string, content: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const selfClosing = content.matchAll(/<PackageReference\b[^>]*Include=["']([^"']+)["'][^>]*Version=["']([^"']+)["'][^>]*\/?>/gi);
  for (const match of selfClosing) {
    records.push({ ecosystem: "nuget", name: match[1]!, version: match[2]!, scope: "runtime", manifestPath: path });
  }
  const block = content.matchAll(/<PackageReference\b[^>]*Include=["']([^"']+)["'][^>]*>([\s\S]*?)<\/PackageReference>/gi);
  for (const match of block) {
    const version = match[2]?.match(/<Version>([^<]+)<\/Version>/i)?.[1] ?? "unknown";
    records.push({ ecosystem: "nuget", name: match[1]!, version, scope: "runtime", manifestPath: path });
  }
  return records;
}

function parseRequirements(path: string, content: string): DependencyRecord[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.replace(/#.*/, "").trim();
    if (!trimmed || trimmed.startsWith("-")) return [];
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*([<>=!~].+)?$/);
    if (!match) return [];
    return [{
      ecosystem: "python" as const,
      name: match[1]!,
      version: match[2]?.trim() || "unbounded",
      scope: path.includes("dev") ? "development" as const : "runtime" as const,
      manifestPath: path,
    }];
  });
}

function parsePom(path: string, content: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const deps = content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/gi);
  for (const match of deps) {
    const block = match[1] ?? "";
    const groupId = block.match(/<groupId>([^<]+)<\/groupId>/i)?.[1] ?? "";
    const artifactId = block.match(/<artifactId>([^<]+)<\/artifactId>/i)?.[1] ?? "";
    const version = block.match(/<version>([^<]+)<\/version>/i)?.[1] ?? "managed";
    const scope = block.match(/<scope>([^<]+)<\/scope>/i)?.[1] ?? "runtime";
    if (!artifactId) continue;
    records.push({
      ecosystem: "maven",
      name: groupId ? `${groupId}:${artifactId}` : artifactId,
      version,
      scope: scope === "test" ? "development" : "runtime",
      manifestPath: path,
    });
  }
  return records;
}

function parseGoMod(path: string, content: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Za-z0-9_.~/-]+)\s+(v[^\s]+)$/);
    if (match && !match[1]?.startsWith("module")) {
      records.push({ ecosystem: "go", name: match[1]!, version: match[2]!, scope: "runtime", manifestPath: path });
    }
  }
  return records;
}

export function parseDependenciesFromManifests(files: Array<{ path: string; content: string }>): DependencyRecord[] {
  const records = files.flatMap((file) => {
    if (/(^|\/)package\.json$/.test(file.path)) return parseNpmPackageJson(file.path, file.content);
    if (/\.csproj$/i.test(file.path)) return parseCsproj(file.path, file.content);
    if (/(^|\/)requirements(-dev)?\.txt$/i.test(file.path)) return parseRequirements(file.path, file.content);
    if (/(^|\/)pom\.xml$/i.test(file.path)) return parsePom(file.path, file.content);
    if (/(^|\/)go\.mod$/i.test(file.path)) return parseGoMod(file.path, file.content);
    return [];
  });

  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.ecosystem}:${record.name}:${record.version}:${record.scope}:${record.manifestPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => `${a.ecosystem}:${a.name}`.localeCompare(`${b.ecosystem}:${b.name}`));
}

function hasAny(files: Array<{ path: string }>, patterns: RegExp[]): boolean {
  return files.some((file) => patterns.some((pattern) => pattern.test(file.path)));
}

function versionRisk(version: string): "high" | "medium" | "low" | null {
  const v = version.trim();
  if (!v || v === "unknown" || v === "unbounded" || v === "*" || v.toLowerCase() === "latest") return "high";
  if (/[<>|]/.test(v)) return "medium";
  if (/^[~^]/.test(v)) return "low";
  return null;
}

function buildFindings(
  files: Array<{ path: string; content: string }>,
  dependencies: DependencyRecord[],
  analyses: ComponentAnalysis[],
): DependencyRiskFinding[] {
  const findings: DependencyRiskFinding[] = [];
  const hasNpmManifest = hasAny(files, [/(^|\/)package\.json$/]);
  const hasNpmLock = hasAny(files, [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/]);
  if (hasNpmManifest && !hasNpmLock) {
    findings.push({
      severity: "medium",
      category: "lockfile",
      message: "npm package.json was found without a lockfile in the fetched manifest set.",
      recommendation: "Confirm the source repo has a committed lockfile or capture exact resolved versions before migration parity testing.",
    });
  }

  const hasCsproj = hasAny(files, [/\.csproj$/i]);
  const hasNugetLock = hasAny(files, [/(^|\/)packages\.lock\.json$/]);
  if (hasCsproj && !hasNugetLock) {
    findings.push({
      severity: "low",
      category: "lockfile",
      message: ".NET project files were found without packages.lock.json.",
      recommendation: "Consider enabling NuGet lock files for reproducible migration test runs.",
    });
  }

  for (const dep of dependencies) {
    const risk = versionRisk(dep.version);
    if (risk) {
      findings.push({
        severity: risk,
        category: "version_policy",
        packageName: dep.name,
        message: `${dep.name} uses a broad or non-exact version range (${dep.version}).`,
        recommendation: "Resolve and pin an approved target version before generating parity baselines or production deployment manifests.",
      });
    }
    if (/(jwt|jsonweb|token|auth|bcrypt|crypto|passport|saml|oauth|openid|security)/i.test(dep.name)) {
      findings.push({
        severity: "info",
        category: "security_sensitive",
        packageName: dep.name,
        message: `${dep.name} participates in authentication, authorization, cryptography, or security-sensitive behavior.`,
        recommendation: "Preserve behavior with focused auth/security parity tests and review target framework defaults carefully.",
      });
    }
  }

  const manifestNames = new Set(dependencies.map((dep) => dep.name.toLowerCase()));
  const externalNames = [...new Set(analyses.flatMap((a) => a.externalDependencies).filter(Boolean))];
  for (const name of externalNames) {
    if (!manifestNames.has(name.toLowerCase())) {
      findings.push({
        severity: "info",
        category: "inventory",
        packageName: name,
        message: `${name} was mentioned by component analysis but was not found in parsed dependency manifests.`,
        recommendation: "Verify whether this is a platform dependency, transitive dependency, or analyzer overreach before planning target packages.",
      });
    }
  }

  return findings;
}

export function buildDependencyRiskReport(input: {
  manifestFiles: Array<{ path: string; content: string }>;
  analyses: ComponentAnalysis[];
  frameworkInfo: FrameworkInfo;
  generatedAt: string;
}): DependencyRiskReport {
  const dependencies = parseDependenciesFromManifests(input.manifestFiles);
  return {
    generatedAt: input.generatedAt,
    frameworkInfo: input.frameworkInfo,
    manifests: input.manifestFiles.map((file) => file.path).sort(),
    dependencies,
    findings: buildFindings(input.manifestFiles, dependencies, input.analyses),
    componentExternalDependencies: Object.fromEntries(input.analyses.map((analysis) => [
      analysis.component.name,
      [...new Set(analysis.externalDependencies)].sort(),
    ])),
  };
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatDependencyRiskMarkdown(report: DependencyRiskReport): string {
  const dependencyRows = report.dependencies.map((dep) =>
    `| ${dep.ecosystem} | ${escapeTable(dep.name)} | ${escapeTable(dep.version)} | ${dep.scope} | ${escapeTable(dep.manifestPath)} |`
  );
  const findingRows = report.findings.map((finding) =>
    `| ${finding.severity} | ${finding.category} | ${escapeTable(finding.packageName ?? "-")} | ${escapeTable(finding.message)} | ${escapeTable(finding.recommendation)} |`
  );

  return `# Dependency Risk Report

_Generated: ${report.generatedAt}_
_Migration: ${report.frameworkInfo.sourceFramework} (${report.frameworkInfo.sourceLanguage}) -> ${report.frameworkInfo.targetFramework} (${report.frameworkInfo.targetLanguage})_

This report is deterministic. It parses dependency manifests and flags migration/security planning risks that are visible without calling an external CVE service. Treat it as an enterprise readiness input, not as a complete vulnerability scan.

## Summary

- **Manifests parsed:** ${report.manifests.length}
- **Dependencies inventoried:** ${report.dependencies.length}
- **Findings:** ${report.findings.length}

## Findings

| Severity | Category | Package | Finding | Recommendation |
|----------|----------|---------|---------|----------------|
${findingRows.join("\n") || "| info | inventory | - | No deterministic dependency risks identified. | Continue with normal package approval and vulnerability scanning. |"}

## Dependency Inventory

| Ecosystem | Package | Version | Scope | Manifest |
|-----------|---------|---------|-------|----------|
${dependencyRows.join("\n") || "| _none_ |  |  |  |  |"}

## Component External Dependencies

${Object.entries(report.componentExternalDependencies).map(([component, deps]) =>
  `- **${component}:** ${deps.length > 0 ? deps.map((dep) => `\`${dep}\``).join(", ") : "none identified"}`
).join("\n")}
`;
}

export async function writeDependencyRiskArtifacts(
  layout: RunLayout,
  report: DependencyRiskReport,
): Promise<void> {
  await fs.writeFile(layout.dependencyRiskJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(layout.dependencyRiskReportPath, formatDependencyRiskMarkdown(report), "utf-8");
}
