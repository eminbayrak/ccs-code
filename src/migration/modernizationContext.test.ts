import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArchitectureBaselineDoc,
  buildPreflightReadinessReport,
  loadModernizationContext,
} from "./modernizationContext.js";
import type { FrameworkInfo, SourceComponent } from "./rewriteTypes.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccs-modernization-context-"));
  tempDirs.push(root);
  return root;
}

describe("modernization context", () => {
  test("loads explicit business or architecture context docs", async () => {
    const root = await tempRoot();
    const docPath = join(root, "modern-use-case.md");
    await writeFile(docPath, "# MCDS Modern Use Case\n\nMove file routing into event-driven processing.", "utf-8");
    process.chdir(root);

    const context = await loadModernizationContext([docPath]);

    expect(context.docs).toHaveLength(1);
    expect(context.docs[0]?.title).toBe("MCDS Modern Use Case");
    expect(context.warnings).toHaveLength(0);

    const baseline = buildArchitectureBaselineDoc(
      context,
      "https://github.com/acme/mcds",
      "csharp",
      "2026-04-25T00:00:00.000Z",
    );
    expect(baseline).toContain("Default Modernization Architecture Profile");
    expect(baseline).toContain("Move file routing into event-driven processing.");
  });

  test("warns when no context docs are available", async () => {
    const root = await tempRoot();
    process.chdir(root);

    const context = await loadModernizationContext();

    expect(context.docs).toHaveLength(0);
    expect(context.warnings[0]).toContain("No modernization context docs");
  });

  test("builds a preflight report with context and missing validation inputs", async () => {
    const root = await tempRoot();
    process.chdir(root);
    const context = await loadModernizationContext([]);
    const frameworkInfo: FrameworkInfo = {
      sourceFramework: "express",
      sourceLanguage: "javascript",
      targetFramework: "aspnet-core",
      targetLanguage: "csharp",
      architecturePattern: "mvc",
      packageManager: "npm",
    };
    const components: SourceComponent[] = [{
      name: "FileRouter",
      type: "controller",
      filePaths: ["src/controllers/FileRouter.js"],
      dependencies: [],
      description: "Routes inbound files.",
    }];

    const report = buildPreflightReadinessReport({
      repoUrl: "https://github.com/acme/mcds",
      generatedAt: "2026-04-25T00:00:00.000Z",
      tree: ["package.json", "src/controllers/FileRouter.js", "README.md"],
      keyFiles: [{ path: "package.json", content: "{}" }],
      frameworkInfo,
      components,
      context,
    });

    expect(report).toContain("Migration Preflight Readiness");
    expect(report).toContain("Source code present | pass");
    expect(report).toContain("Validation samples present | warn");
    expect(report).toContain("Sample inputs/outputs");
  });

  test("loads well-known context files from the current workspace", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "modern-use-case.md"), "# Business Goal\n\nReduce manual file handling.", "utf-8");
    process.chdir(root);

    const context = await loadModernizationContext();

    expect(context.docs.map((doc) => doc.path)).toContain("docs/modern-use-case.md");
    expect(context.docs[0]?.content).toContain("Reduce manual file handling.");
  });

  test("can ignore well-known context files for neutral benchmark runs", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "modern-use-case.md"), "# Business Goal\n\nReduce manual file handling.", "utf-8");
    process.chdir(root);

    const context = await loadModernizationContext([], { includeWellKnown: false });

    expect(context.docs).toHaveLength(0);
    expect(context.warnings[0]).toContain("No modernization context docs");
  });
});
