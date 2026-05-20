/**
 * Agent contracts for the CCS Code migration execution layer.
 *
 * Architecture: one Orchestrator, N specialized agents.
 * Each agent receives only the context it needs, does one job, returns a result.
 * Agents never call each other directly — they communicate through MigrationState.
 */

import type { LLMProvider } from "../../llm/index.js";

// ---------------------------------------------------------------------------
// Shared agent context — passed to every agent constructor
// ---------------------------------------------------------------------------

export type AgentContext = {
  /** LLM provider for this agent's calls */
  provider: LLMProvider;
  /** Root directory of the repository being migrated */
  repoDir: string;
  /** Path to the active migration plan file */
  planFile: string;
  /** Optional progress callback for terminal output */
  onProgress?: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// Base agent interface — every agent implements this
// ---------------------------------------------------------------------------

export interface MigrationAgent<TInput, TOutput> {
  readonly name: string;
  run(input: TInput): Promise<AgentResult<TOutput>>;
}

export type AgentResult<T> =
  | { ok: true;  value: T }
  | { ok: false; error: string; recoverable: boolean };

export function ok<T>(value: T): AgentResult<T> {
  return { ok: true, value };
}

export function fail(error: string, recoverable = true): AgentResult<never> {
  return { ok: false, error, recoverable };
}

// ---------------------------------------------------------------------------
// ScannerAgent
// ---------------------------------------------------------------------------

export type ScannerInput = {
  sourceDir: string;
  ignore?: string[];
};

export type FileNode = {
  /** Absolute path */
  path: string;
  /** Paths this file imports (internal only) */
  dependsOn: string[];
  /** Language detected */
  lang: string;
  /** Approximate line count */
  lines: number;
  /** Number of top-level symbols (functions, classes, methods) — from AST/Tree-sitter when available */
  symbolCount?: number;
  /** Highest cyclomatic complexity across all symbols — flags files needing careful migration */
  maxComplexity?: number;
  /** Parser used: "ast" | "tree_sitter" | "regex" */
  analysisMethod?: "ast" | "tree_sitter" | "regex";
};

export type ScannerOutput = {
  /** Dependency-ordered list: leaves first, dependents last */
  orderedFiles: FileNode[];
  totalFiles: number;
  languages: Record<string, number>;
};

// ---------------------------------------------------------------------------
// PlannerAgent
// ---------------------------------------------------------------------------

export type PlannerInput = {
  /** Natural language transformation description, e.g. "migrate CommonJS to ESM" */
  transformation: string;
  /** Scan result from ScannerAgent */
  scan: ScannerOutput;
  /** Build command to use for validation (auto-detected if not provided) */
  buildCommand?: string;
};

export type PlannerOutput = {
  planId: string;
  transformation: string;
  promptFile: string;
  buildCommand: string;
  /** Ordered file paths ready for migration */
  filePaths: string[];
};

// ---------------------------------------------------------------------------
// WriterAgent
// ---------------------------------------------------------------------------

export type WriterInput = {
  /** Absolute path to the file to transform */
  filePath: string;
  /** Full content of the migration prompt template */
  promptTemplate: string;
  /** Current file content */
  fileContent: string;
  /** Optional symbol metadata from ScannerAgent — injected into LLM prompt */
  symbolCount?: number;
  maxComplexity?: number;
  analysisMethod?: "ast" | "tree_sitter" | "regex";
};

export type WriterOutput = {
  filePath: string;
  /** Backup path created before writing */
  backupPath: string;
  /** Number of lines changed (rough estimate) */
  linesChanged: number;
};

// ---------------------------------------------------------------------------
// BuildAgent
// ---------------------------------------------------------------------------

export type BuildInput = {
  /** Shell command to run, e.g. "npx tsc --noEmit" */
  command: string;
  cwd: string;
};

export type BuildError = {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
};

export type BuildOutput = {
  success: boolean;
  errors: BuildError[];
  rawOutput: string;
};

// ---------------------------------------------------------------------------
// FixerAgent
// ---------------------------------------------------------------------------

export type FixerInput = {
  filePath: string;
  fileContent: string;
  errors: BuildError[];
  /** Original migration prompt — gives fixer context about intent */
  promptTemplate: string;
  attemptNumber: number;
};

export type FixerOutput = {
  filePath: string;
  fixed: boolean;
  linesChanged: number;
};

// ---------------------------------------------------------------------------
// VerifierAgent
// ---------------------------------------------------------------------------

export type VerifierInput = {
  repoDir: string;
  /** Patterns that must NOT appear in any migrated file */
  forbiddenPatterns: string[];
  /** Build command for final validation */
  buildCommand: string;
  /** Optional test command */
  testCommand?: string;
};

export type VerifierOutput = {
  passed: boolean;
  remainingPatterns: Array<{ pattern: string; files: string[] }>;
  buildPassed: boolean;
  testsPassed: boolean | null;
  summary: string;
};
