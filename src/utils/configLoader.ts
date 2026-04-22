import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";

export type ConfigFile = {
  path: string;
  name: string;
  priority: "global" | "project" | "rules";
};

export type CapabilityConfigFile = {
  path: string;
  name: string;
  category: "tools" | "connectors" | "agents";
};

/**
 * Mirrors the Claude Code claudemd.ts discovery hierarchy exactly:
 *
 * Priority (lowest → highest):
 *   1. ~/.ccs/CCS.md         — Global personal instructions (all projects)
 *   2. ./CCS.md              — Project-level instructions
 *   3. ./.ccs/rules/*.md     — Granular per-project rules (highest priority)
 *
 * Files with higher priority are injected later into the system prompt,
 * so the LLM pays more attention to them.
 */
export async function loadInstructions(cwd: string): Promise<ConfigFile[]> {
  const instructions: ConfigFile[] = [];

  // 1. Global personal instructions (~/.ccs/CCS.md)
  try {
    const globalPath = join(homedir(), ".ccs", "CCS.md");
    await fs.access(globalPath);
    instructions.push({ path: globalPath, name: "~/.ccs/CCS.md", priority: "global" });
  } catch {
    // Not present — fine, it's optional
  }

  // 2. Project-level CCS.md (./CCS.md)
  try {
    const projectPath = join(cwd, "CCS.md");
    await fs.access(projectPath);
    instructions.push({ path: projectPath, name: "CCS.md", priority: "project" });
  } catch {
    // Not present — fine
  }

  // 3. Granular rules (.ccs/rules/*.md) — highest priority
  try {
    const rulesDir = join(cwd, ".ccs", "rules");
    const entries = await fs.readdir(rulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        instructions.push({
          path: join(rulesDir, entry.name),
          name: `.ccs/rules/${entry.name}`,
          priority: "rules",
        });
      }
    }
  } catch {
    // Rules dir doesn't exist — fine
  }

  return instructions;
}

/**
 * Reads all discovered instruction files and merges their content
 * in priority order (lowest first, highest last = highest attention from LLM).
 */
export async function buildSystemPrompt(cwd: string): Promise<string> {
  const files = await loadInstructions(cwd);
  const parts: string[] = [];

  for (const file of files) {
    try {
      const content = await fs.readFile(file.path, "utf-8");
      if (content.trim()) {
        parts.push(`# Instructions from ${file.name}\n\n${content.trim()}`);
      }
    } catch {
      // Skip unreadable files silently
    }
  }

  return parts.join("\n\n---\n\n");
}

/** Discover SKILL.md files from a given skills directory. */
async function discoverSkillsInDir(
  skillsDir: string,
  priority: ConfigFile["priority"],
): Promise<ConfigFile[]> {
  const skills: ConfigFile[] = [];
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        skills.push({ path: join(skillsDir, entry.name), name: entry.name, priority });
      }
      if (entry.isDirectory()) {
        try {
          const skillPath = join(skillsDir, entry.name, "SKILL.md");
          await fs.access(skillPath);
          skills.push({ path: skillPath, name: `${entry.name}/SKILL.md`, priority });
        } catch {
          // No SKILL.md
        }
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return skills;
}

/**
 * Discovers skills from two locations:
 *   1. .ccs/skills/  — project-level CCS skills
 *   2. vault/skills/ — KnowledgeForge vault skills (if vault exists in cwd)
 *   3. skills/       — vault skills when cwd IS the vault
 */
export async function loadSkills(cwd: string): Promise<ConfigFile[]> {
  const results = await Promise.all([
    discoverSkillsInDir(join(cwd, ".ccs", "skills"), "project"),
    discoverSkillsInDir(join(cwd, "vault", "skills"), "project"),
    discoverSkillsInDir(join(cwd, "skills"), "project"),
  ]);

  // De-duplicate by path
  const seen = new Set<string>();
  const skills: ConfigFile[] = [];
  for (const batch of results) {
    for (const s of batch) {
      if (!seen.has(s.path)) {
        seen.add(s.path);
        skills.push(s);
      }
    }
  }
  return skills;
}

async function loadCapabilityFiles(
  cwd: string,
  dirName: "tools" | "connectors" | "agents",
): Promise<CapabilityConfigFile[]> {
  const files: CapabilityConfigFile[] = [];

  try {
    const dir = join(cwd, ".ccs", dirName);
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".md"))) {
        files.push({
          path: join(dir, entry.name),
          name: `.ccs/${dirName}/${entry.name}`,
          category: dirName,
        });
      }
    }
  } catch {
    // Directory does not exist yet.
  }

  return files;
}

export async function loadToolDefinitions(cwd: string): Promise<CapabilityConfigFile[]> {
  return loadCapabilityFiles(cwd, "tools");
}

export async function loadConnectorDefinitions(cwd: string): Promise<CapabilityConfigFile[]> {
  return loadCapabilityFiles(cwd, "connectors");
}

export async function loadAgentDefinitions(cwd: string): Promise<CapabilityConfigFile[]> {
  return loadCapabilityFiles(cwd, "agents");
}
