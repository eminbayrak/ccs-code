import React, { useState, useEffect, useRef, useCallback } from "react";
import { Text, Box, useApp, useInput, Static } from "ink";
import TextInput from "ink-text-input";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { usePaste } from "../hooks/usePaste";
import { StatusBar } from "./StatusBar";
import { HelpMenu } from "./HelpMenu";
import { WelcomeBox } from "./WelcomeBox";
import { MarkdownText } from "./MarkdownText";
import { SuggestionList, type SuggestionItem } from "./SuggestionList";
import {
  loadInstructions,
  loadSkills,
  buildSystemPrompt,
  type ConfigFile,
} from "../utils/configLoader";
import { getProjectFiles, filterFiles } from "../utils/filePicker";
import { createProvider } from "../llm/index";
import type { LLMProvider } from "../llm/index";
import type { Message } from "../llm/providers/base";
import { Orchestrator } from "../orchestrator/index";
import {
  getPendingApprovals,
  resolveApproval,
} from "../governance/approvals";
import { listAgentRuns } from "../tasks/agentRuns";
import type { PermissionMode } from "../governance/permissions";
import { hooksCommandHandler } from "../commands/hooks";
import {
  handleVaultCommand,
  handleSyncCommand,
  handleIngestCommand,
  handleLintCommand,
  handleGraphCommand,
  handleRewriteCommand,
  handleIndexCommand,
  handleEnrichCommand,
  handleAskCommand,
  handleGuideCommand,
  readVaultConfig,
  saveVaultConfig,
  initVault,
} from "../commands/vault";
import { handleHarvestCommand } from "../commands/harvest";
import { handleMigrateCommand } from "../commands/migrate";
import {
  routeIntent,
  routeToolIntent,
  decisionToSlashCommand,
  formatRouterAck,
  formatRouterClarification,
  formatToolIntentAck,
  isSupportedTargetLanguage,
  normaliseLang,
  type RouterDecision,
} from "../migration/intentRouter";
import { ScanProgressLog } from "./ScanProgressLog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UIMessage = {
  id: string;                    // unique key for Static
  role: "user" | "assistant";
  content: string;
};

function createUIMessage(role: UIMessage["role"], content: string): UIMessage {
  return {
    id: randomUUID(),
    role,
    content,
  };
}

type ToolExecution = {
  id: string;
  name: string;
  details?: string;
  isComplete: boolean;
};

type SuggestionMode = "file" | "command" | null;

// ---------------------------------------------------------------------------
// Slash Commands registry
// ---------------------------------------------------------------------------

const SLASH_COMMANDS: SuggestionItem[] = [
  // ---- /migrate (the main migration surface) ------------------------------
  // Each subcommand is its own entry so typing `/m` shows the full menu and
  // arrow-key navigation lands on the exact action the user wants.
  { id: "migrate.rewrite",     label: "/migrate rewrite --repo <url> --to <lang> [--from <fw>] [--context <path>] [--yes]",
    description: "Scan, reverse-engineer, and verify a legacy repo end-to-end" },
  { id: "migrate.reverse-eng", label: "/migrate reverse-eng --repo <url> [--to <lang>] [--context <path>] [--yes]",
    description: "Persist reverse-engineering and graph artifacts only (no agent contract)" },
  { id: "migrate.scan",        label: "/migrate scan --repo <url> --lang <lang> [--yes]",
    description: "Scan external SOAP/service calls in a Node.js repo" },
  { id: "migrate.open",        label: "/migrate open [<slug>] [--dashboard]",
    description: "Open the latest run folder, or its dashboard.html" },
  { id: "migrate.dashboard",   label: "/migrate dashboard [<slug>] [--open]",
    description: "Show or open the dashboard for a run" },
  { id: "migrate.clean",       label: "/migrate clean [<slug>|--all] [--yes]",
    description: "Remove old run folders under your migration root" },
  { id: "migrate.status",      label: "/migrate status",
    description: "Show migration progress table" },
  { id: "migrate.context",     label: "/migrate context <ServiceName>",
    description: "Print a service context doc" },
  { id: "migrate.verify",      label: "/migrate verify <ServiceName>",
    description: "Mark a service as verified" },
  { id: "migrate.db",          label: "/migrate db --service <name> [--yes]",
    description: "Live database schema extraction (read-only, user-approved)" },
  { id: "migrate.plugin",      label: "/migrate plugin",
    description: "List installed migration plugins" },
  { id: "migrate",             label: "/migrate",
    description: "Migration intelligence — type /m to see all subcommands" },

  // ---- Agent / setup -------------------------------------------------------
  { id: "setup",       label: "/setup",       description: "Codex / Claude Code MCP setup snippets" },
  { id: "guide",       label: "/guide",       description: "Open the interactive how-to guide" },

  // ---- Vault / knowledge base ---------------------------------------------
  { id: "vault.init",   label: "/vault init [<path>]",  description: "Create a new CCS vault" },
  { id: "vault.status", label: "/vault status",         description: "Show active vault counts" },
  { id: "vault.audit",  label: "/vault audit",          description: "Health check: ensure harvested memories were ingested" },
  { id: "vault",        label: "/vault <init|status|audit>", description: "Manage the CCS vault" },
  { id: "sync",         label: "/sync",                 description: "Sync configured sources (GitHub, Confluence) into raw/" },
  { id: "harvest",      label: "/harvest",              description: "Mine AI chat logs (Claude, Cursor, Copilot) into the vault" },
  { id: "ingest",       label: "/ingest",               description: "Process raw/ files into wiki pages" },
  { id: "enrich",       label: "/enrich",               description: "AI summaries, tags, and links for wiki pages" },
  { id: "graph",        label: "/graph",                description: "Build the knowledge-base graph (vis.js)" },
  { id: "index",        label: "/index",                description: "Rebuild wiki/_master-index.md" },
  { id: "ask",          label: "/ask <question>",       description: "Answer a question from your wiki" },
  { id: "lint",         label: "/lint",                 description: "Wiki health checks (broken links, orphans, staleness)" },
  { id: "rewrite",      label: "/rewrite <service|order>", description: "Generate a rewrite brief or system rewrite order" },

  // ---- Core / runtime ------------------------------------------------------
  { id: "clear",      label: "/clear",      description: "Clear conversation history" },
  { id: "skills",     label: "/skills",     description: "List loaded skills" },
  { id: "model",      label: "/model",      description: "Show active model" },
  { id: "approvals",  label: "/approvals",  description: "List pending approvals" },
  { id: "approve",    label: "/approve <id>", description: "Approve a pending action" },
  { id: "reject",     label: "/reject <id>",  description: "Reject a pending action" },
  { id: "tasks",      label: "/tasks",        description: "List background agent tasks" },
  { id: "mode",       label: "/mode <default|plan|permissive>", description: "Set permission mode" },
  { id: "hooks",      label: "/hooks <list|enable|disable|clear>", description: "Manage event hooks" },
  { id: "help",       label: "/help",       description: "Toggle keyboard shortcuts" },
  { id: "exit",       label: "/exit",       description: "Exit CCS Code" },
];

/**
 * Match a slash query against the registry.
 *
 * The registry contains both top-level commands (e.g. `/migrate`) and
 * dot-prefixed subcommand entries (e.g. `/migrate rewrite`). The user types
 * the slash command they want — `/m`, `/mig`, `/migrate r`, etc. — and we
 * compare the query against the visible label, ignoring the separator
 * difference between `migrate.rewrite` (registry id) and `migrate rewrite`
 * (label). Multi-word queries match every word as a contiguous prefix.
 */
function filterCommands(query: string): SuggestionItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_COMMANDS;
  // Score by where the match lands: prefix match on the label wins, otherwise
  // any-substring match. This keeps `/m` showing every /migrate row first.
  const scored = SLASH_COMMANDS
    .map((c) => {
      const label = c.label.toLowerCase();
      const start = label.indexOf("/" + q);
      const anywhere = label.indexOf(q);
      if (start === 0) return { item: c, rank: 0 };
      if (start > 0)  return { item: c, rank: 1 };
      if (anywhere >= 0) return { item: c, rank: 2 };
      return null;
    })
    .filter((x): x is { item: SuggestionItem; rank: number } => x !== null)
    .sort((a, b) => a.rank - b.rank || a.item.label.length - b.item.label.length);
  return scored.map((s) => s.item);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect the last @ trigger and extract the query after it. */
function detectAtTrigger(value: string): { triggerStart: number; query: string; } | null {
  const idx = value.lastIndexOf("@");
  if (idx === -1) return null;
  const after = value.slice(idx + 1);
  if (after.includes(" ")) return null; // space after @ = done typing
  return { triggerStart: idx, query: after };
}

/** Detect a / trigger at the start of the line. */
function detectSlashTrigger(value: string): { query: string; } | null {
  if (!value.startsWith("/")) return null;
  return { query: value.slice(1) };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function wrapLine(value: string, width: number): string[] {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function UserPromptBlock({ content, width }: { content: string; width: number }) {
  const barWidth = Math.max(24, width);
  const textWidth = Math.max(8, barWidth - 6);
  const lines = wrapLine(content, textWidth);
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      paddingX={1}
      paddingY={1}
      width={barWidth}
      backgroundColor="#30343d"
    >
      {lines.map((line, index) => {
        const prefix = index === 0 ? "› " : "  ";
        const rendered = `${prefix}${line}`;
        return (
          <Text key={index} color="#c8d1f0">
            {rendered}
          </Text>
        );
      })}
    </Box>
  );
}

function AssistantMessageBlock({ content, width }: { content: string; width: number }) {
  const icon = /^error:/i.test(content.trim()) ? "✕" : "●";
  const iconColor = icon === "✕" ? "red" : "#8b92ac";
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={iconColor}>{icon}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <MarkdownText content={content} width={Math.max(32, width - 3)} />
      </Box>
    </Box>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatError(raw: string): string {
  try {
    // Detect and format Gemini JSON errors
    if (raw.includes('"error":') && raw.includes('{')) {
      const jsonStart = raw.indexOf('{');
      const jsonText = raw.slice(jsonStart);
      const json = JSON.parse(jsonText);
      const err = json.error || json;
      const message = err.message || "Unknown error";
      const status = err.status || "ERROR";
      const code = err.code || "";
      
      let formatted = `### ✗ Request Failed (${status})\n\n**${message}**\n\n`;
      
      if (err.details) {
        err.details.forEach((d: any) => {
          if (d.violations) {
            d.violations.forEach((v: any) => {
              formatted += `· **${v.quotaMetric.split('/').pop()}**: ${v.quotaId} (${v.quotaValue})\n`;
            });
          }
          if (d.retryDelay) {
            formatted += `\n**Retry in:** ${d.retryDelay}\n`;
          }
        });
      }
      
      return formatted;
    }
  } catch { /* fallback to raw */ }
  return raw;
}

function taskStatusIcon(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("error") || s.includes("fail")) return "✗";
  if (s.includes("complete") || s.includes("done") || s.includes("success")) return "✓";
  if (s.includes("running") || s.includes("active") || s.includes("processing")) return "●";
  return "⎿";
}

import { ToolBlock } from "./ToolBlock";

// ... (keep other imports)

function ThinkingBlock({ startTime }: { startTime: number }) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const frameTimer = setInterval(() => setFrame(f => (f + 1) % frames.length), 80);
    const elapsedTimer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 100);
    return () => {
      clearInterval(frameTimer);
      clearInterval(elapsedTimer);
    };
  }, [startTime]);

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} marginTop={1}>
      <Box gap={1}>
        <Text color="#63b3ed" bold>{frames[frame]} Thinking...</Text>
        <Text color="#718096">(esc to cancel, {elapsed}s)</Text>
      </Box>
      <Text color="#718096">Tip: Use /migrate open --dashboard to see visual reports</Text>
    </Box>
  );
}

function MainFooter({ 
  workspacePath, 
  activeModel, 
  permissionMode,
  columns,
  skillsCount,
  instructionsCount,
  vaultPath
}: { 
  workspacePath: string; 
  activeModel: string; 
  permissionMode: string;
  columns: number;
  skillsCount: number;
  instructionsCount: number;
  vaultPath: string | null;
}) {
  const [branch, setBranch] = useState("...");
  
  useEffect(() => {
    // Attempt to get real branch
    import("child_process").then(({ exec }) => {
      exec("git rev-parse --abbrev-ref HEAD", (err, stdout) => {
        if (!err && stdout) setBranch(stdout.trim());
      });
    });
  }, []);

  const cwd = workspacePath.replace(homedir(), "~");
  const vaultDisplay = vaultPath ? vaultPath.replace(homedir(), "~") : "no active vault";
  
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box 
        flexDirection="row" 
        justifyContent="space-between" 
        paddingX={1} 
        paddingY={0}
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor="#2d3748"
      >
        <Text color="#63b3ed">mode <Text color="#ffffff">{permissionMode}</Text></Text>
        <Text color="#718096">{skillsCount} skills &middot; {instructionsCount} instructions &middot; 1 MCP server</Text>
      </Box>
      
      <Box flexDirection="row" width={columns} paddingX={1} marginTop={1}>
        <Box flexDirection="column" width="30%">
          <Text color="#718096">workspace</Text>
          <Text color="#ffffff" wrap="truncate-end">{cwd}</Text>
        </Box>
        <Box flexDirection="column" width="25%">
          <Text color="#718096">active vault</Text>
          <Text color={vaultPath ? "#ffffff" : "#f56565"} wrap="truncate-end">{vaultDisplay}</Text>
        </Box>
        <Box flexDirection="column" width="15%">
          <Text color="#718096">branch</Text>
          <Text color="#ffffff" wrap="truncate-end">{branch}</Text>
        </Box>
        <Box flexDirection="column" width="15%">
          <Text color="#718096">permission</Text>
          <Text color={permissionMode === "permissive" ? "#48bb78" : "#f56565"}>
            {permissionMode === "default" ? "default" : permissionMode}
          </Text>
        </Box>
        <Box flexDirection="column" width="15%" alignItems="flex-end">
          <Text color="#718096">/model</Text>
          <Text color="#ffffff">{activeModel}</Text>
        </Box>
      </Box>
    </Box>
  );
}

const DONE_VERBS = ["Completed", "Finished", "Done", "Processed", "Ready"];
let doneVerbIdx = 0;
function nextDoneVerb() {
  return DONE_VERBS[doneVerbIdx++ % DONE_VERBS.length]!;
}



export function App({ initialPrompt }: { initialPrompt?: string; }) {
  const { exit } = useApp();
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();

  // Chat state
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");

  // Processing state
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStalled, setIsStalled] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolExecution[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  // Welcome box: shown on every app start, hidden on first message.
  // Initialized synchronously so it's never overwritten by an async boot effect.
  const [showWelcome, setShowWelcome] = useState(!initialPrompt);
  const [completionLabel, setCompletionLabel] = useState<string | null>(null);
  const processingStartRef = useRef<number>(0);

  // Vault state
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [isSetupMode, setIsSetupMode] = useState(false);
  const [setupInput, setSetupInput] = useState("");
  const [setupStep, setSetupStep] = useState<"input" | "success">("input");

  // Migration Wizard
  const [isMigrateWizard, setIsMigrateWizard] = useState(false);
  const [migrateWizardStep, setMigrateWizardStep] = useState(0);
  const [migrateWizardData, setMigrateWizardData] = useState({ repo: "", lang: "csharp" });

  // Pending migration decision: set when the user types a natural-language
  // request that has a repo but no target language. The next user message
  // (a single language word, or "cancel") completes or drops it.
  const [pendingMigration, setPendingMigration] = useState<RouterDecision | null>(null);

  // Migration scan live log (accumulated progress lines shown during scan)
  const [migrateLogs, setMigrateLogs] = useState<string[]>([]);
  const [operationLogs, setOperationLogs] = useState<string[]>([]);

  // Environment
  const [instructions, setInstructions] = useState<ConfigFile[]>([]);
  const [skills, setSkills] = useState<ConfigFile[]>([]);
  const [activeModel, setActiveModel] = useState("Loading...");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");

  // Suggestion state
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>(null);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [atTriggerStart, setAtTriggerStart] = useState(-1);
  const [inputKey, setInputKey] = useState(0); // bumped to force TextInput remount → cursor reset

  // Injected files (path → content)
  const injectedFilesRef = useRef<Map<string, string>>(new Map());
  const pastedBlocksRef = useRef<Map<string, string>>(new Map());

  // ---------------------------------------------------------------------------
  // Paste handling — intercepts bracketed paste before Ink's key parser sees it
  // ---------------------------------------------------------------------------

  // Which input is currently active so paste knows where to land
  const activeInputRef = useRef<"main" | "setup" | "wizard">("main");

  const isPastingRef = usePaste(
    useCallback((text: string) => {
      const target = activeInputRef.current;
      if (target === "main") {
        const lines = text.split("\n").length;
        if (lines > 1) {
          const token = `[Pasted Text: ${lines} lines]`;
          pastedBlocksRef.current.set(token, text);
          setInput((prev) => prev + token);
        } else {
          setInput((prev) => prev + text);
        }
        setInputKey((k) => k + 1);
      } else if (target === "setup") {
        setSetupInput((prev) => prev + text);
      } else if (target === "wizard") {
        setMigrateWizardData((prev) => ({
          ...prev,
          repo: migrateWizardStep === 0 ? text : prev.repo,
          lang: migrateWizardStep === 1 ? text : prev.lang,
        }));
        setInput(text);
        setInputKey((k) => k + 1);
      }
    }, [migrateWizardStep]),
    isProcessing,
  );

  // LLM provider
  const providerRef = useRef<LLMProvider | null>(null);
  const orchestratorRef = useRef<Orchestrator | null>(null);
  const systemPromptRef = useRef<string>("");
  const allFilesRef = useRef<{ path: string; label: string; }[]>([]);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  const triggerBoot = useCallback(async () => {
    const cwd = process.cwd();

    // Check for vault configuration
    const vaultCfg = await readVaultConfig();
    if (vaultCfg.activeVault) {
      setVaultPath(vaultCfg.activeVault);
    }

    const [loadedInstructions, loadedSkills, systemPrompt, projectFiles] =
      await Promise.all([
        loadInstructions(cwd),
        loadSkills(cwd),
        buildSystemPrompt(cwd),
        getProjectFiles(cwd),
      ]);

    setInstructions(loadedInstructions);
    setSkills(loadedSkills);
    systemPromptRef.current = systemPrompt;
    allFilesRef.current = projectFiles;

    try {
      const provider = await createProvider();
      providerRef.current = provider;
      orchestratorRef.current = new Orchestrator(provider);
      setActiveModel(provider.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActiveModel("Not connected");
      setMessages([
        createUIMessage("assistant", `⚠️  No LLM provider configured.\n\nError: ${msg}`),
      ]);
    }
  }, []);

  useEffect(() => {
    triggerBoot();
  }, [triggerBoot]);


  // ---------------------------------------------------------------------------
  // Input change — detect @ and / triggers
  // ---------------------------------------------------------------------------

  const handleInputChange = useCallback(
    async (value: string) => {
      // Un-escape common terminal escapes if present
      const cleaned = value.replace(/\\\//g, "/").replace(/\\ /g, " ");
      setInput(cleaned);
      setSelectedIdx(0);

      // Claude-like help behavior: show help only while the input is exactly '?'.
      const isHelpTrigger = cleaned.trim() === "?";
      if (!isProcessing) {
        if (isHelpTrigger && !helpOpen) setHelpOpen(true);
        if (!isHelpTrigger && helpOpen) setHelpOpen(false);
      }

      // --- @ file trigger ---
      const atResult = detectAtTrigger(cleaned);
      if (atResult) {
        setSuggestionMode("file");
        setAtTriggerStart(atResult.triggerStart);
        const matched = filterFiles(allFilesRef.current, atResult.query);
        setSuggestions(matched.map((f) => ({ id: f.path, label: f.path })));
        return;
      }

      // --- / command trigger ---
      const slashResult = detectSlashTrigger(cleaned);
      if (slashResult) {
        setSuggestionMode("command");
        setSuggestions(filterCommands(slashResult.query));
        return;
      }

      // No trigger
      setSuggestionMode(null);
      setSuggestions([]);
    },
    [helpOpen, isProcessing],
  );

  // ---------------------------------------------------------------------------
  // Keyboard: navigate suggestions or toggle helpers
  // ---------------------------------------------------------------------------

  useInput((inputChar, key) => {
    // Never act on escape-like keys during a bracketed paste — the paste start
    // sequence \x1b[200~ triggers key.escape before the text arrives.
    if (isPastingRef.current) return;

    if (key.escape && helpOpen) {
      setHelpOpen(false);
      return;
    }

    if (key.escape && isMigrateWizard) {
      setIsMigrateWizard(false);
      setMessages((prev) => [...prev, createUIMessage("assistant", "Migration Wizard cancelled.")]);
      return;
    }

    if (!suggestionMode) return;

    // Esc → close suggestion list
    if (key.escape) {
      setSuggestionMode(null);
      setSuggestions([]);
      return;
    }

    if (suggestions.length === 0) return;

    // ↑ / ↓ navigation
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(suggestions.length - 1, i + 1));
      return;
    }

    // Tab → accept selected
    if (key.tab) {
      applySuggestion(suggestions[selectedIdx]);
    }
  });

  // ---------------------------------------------------------------------------
  // Apply a selected suggestion
  // ---------------------------------------------------------------------------

  const applySuggestion = useCallback(
    async (item: SuggestionItem | undefined) => {
      if (!item) return;

      if (suggestionMode === "file") {
        // Replace @<query> with @filename token and a trailing space
        const before = input.slice(0, atTriggerStart);
        const newInput = `${before}@${item.label} `;
        setInput(newInput);
        setInputKey((k) => k + 1); // Force TextInput remount so cursor jumps to end

        // Read and cache the file content for injection
        try {
          const content = await fs.readFile(
            join(process.cwd(), item.label),
            "utf-8",
          );
          injectedFilesRef.current.set(item.label, content);
        } catch {
          // Silently ignore unreadable files
        }
      } else if (suggestionMode === "command") {
        // Decide whether to execute the command immediately or pre-fill the
        // input so the user can supply arguments. We look at the LABEL — if it
        // contains a placeholder (`<...>` or `[...]`), we populate the editable
        // static prefix and leave the cursor at the end.
        // Otherwise we run it.
        const label = item.label;
        const placeholderIdx = (() => {
          const candidates = [label.indexOf("<"), label.indexOf("[")];
          const valid = candidates.filter((i) => i > 0);
          return valid.length > 0 ? Math.min(...valid) : -1;
        })();

        if (placeholderIdx > 0) {
          // Trim the label up to the first placeholder/flag and use that as
          // the editable starting text.
          const prefix = label.slice(0, placeholderIdx).trim();
          setInput(`${prefix} `);
          setInputKey((k) => k + 1);
        } else {
          // No placeholder — extract the bare command from the label
          // (e.g. "/sync") and dispatch it.
          const command = label.replace(/^\//, "").trim();
          executeSlashCommand(command);
          setInput("");
        }
      }

      setSuggestionMode(null);
      setSuggestions([]);
    },
    [suggestionMode, input, atTriggerStart],
  );

  // ---------------------------------------------------------------------------
  // Execute slash commands
  // ---------------------------------------------------------------------------

  const executeSlashCommand = (raw: string) => {
    const [id, ...args] = raw.trim().split(/\s+/);
    const arg = args.join(" ").trim();

    // Dismiss welcome box on any command, regardless of how it was triggered
    setShowWelcome(false);
    // Clear previous operation logs
    setMigrateLogs([]);
    setOperationLogs([]);

    if (!id) return;

    const vaultCommands = ["vault", "sync", "ingest", "graph", "lint", "rewrite", "index", "enrich", "ask", "harvest", "migrate"];
    if (vaultCommands.includes(id) && !vaultPath) {
      setIsSetupMode(true);
      return;
    }

    switch (id) {
      // ------------------------------------------------------------------
      // CCS Code vault commands
      // ------------------------------------------------------------------
      case "vault": {
        setIsProcessing(true);
        setActiveTools([{ id: "vault", name: "Managing vault", isComplete: false }]);
        setOperationLogs(["Managing vault"]);
        processingStartRef.current = Date.now();
        handleVaultCommand(args, process.cwd()).then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setIsProcessing(false);
          setActiveTools([]);
          setOperationLogs([]);
        }).catch(err => {
          setIsProcessing(false);
          setActiveTools([]);
          setOperationLogs([]);
          setMessages((prev) => [...prev, createUIMessage("assistant", `Error: ${err.message}`)]);
        });
        break;
      }
      case "sync": {
        setIsProcessing(true);
        setActiveTools([{ id: "sync", name: "Source Syncer", details: "Syncing sources...", isComplete: false }]);
        processingStartRef.current = Date.now();
        handleSyncCommand(args, process.cwd()).then((output) => {
          const elapsed = formatElapsed(Date.now() - processingStartRef.current);
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setIsProcessing(false);
          setActiveTools([]);
          setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
        }).catch(err => {
          setIsProcessing(false);
          setActiveTools([]);
          setMessages((prev) => [...prev, createUIMessage("assistant", `Error: ${err.message}`)]);
        });
        break;
      }
      case "ingest": {
        setIsProcessing(true);
        setActiveTools([{ id: "ingest", name: "Ingestor", details: "Processing raw files...", isComplete: false }]);
        processingStartRef.current = Date.now();
        handleIngestCommand(args, process.cwd()).then((output) => {
          const elapsed = formatElapsed(Date.now() - processingStartRef.current);
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setIsProcessing(false);
          setActiveTools([]);
          setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
        }).catch(err => {
          setIsProcessing(false);
          setActiveTools([]);
          setMessages((prev) => [...prev, createUIMessage("assistant", `Error: ${err.message}`)]);
        });
        break;
      }
      case "graph": {
        handleGraphCommand(args, process.cwd()).then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
        });
        break;
      }
      case "lint": {
        handleLintCommand(args, process.cwd()).then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
        });
        break;
      }
      case "rewrite": {
        if (!arg) {
          setMessages((prev) => [...prev, createUIMessage("assistant", "Usage: /rewrite <service-name>\n       /rewrite order")]);
          break;
        }
        handleRewriteCommand([id, ...args], process.cwd()).then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
        });
        break;
      }
      case "index": {
        setOperationLogs(["Rebuilding master index"]);
        handleIndexCommand(args, process.cwd()).then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setOperationLogs([]);
        });
        break;
      }
      case "ask": {
        const question = args.join(" ").trim();
        if (!question) {
          setMessages((prev) => [...prev, createUIMessage("assistant", "Usage: /ask <question>\nExample: /ask what did I discuss about React hooks?")]);
          break;
        }
        setShowWelcome(false);
        setIsProcessing(true);
        setActiveTools([{ id: "1", name: `Searching wiki for: ${question}`, isComplete: false }]);
        setOperationLogs([`Searching wiki for: ${question}`]);
        processingStartRef.current = Date.now();
        handleAskCommand(question, process.cwd()).then((output) => {
          const elapsed = formatElapsed(Date.now() - processingStartRef.current);
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setActiveTools([]);
          setIsProcessing(false);
          setOperationLogs([]);
          setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
        });
        break;
      }
      case "harvest": {
        setIsProcessing(true);
        setActiveTools([{ id: "harvest", name: "Mining AI logs", isComplete: false }]);
        setOperationLogs(["Mining local AI histories", "Reading Claude, Cursor, and VS Code logs"]);
        processingStartRef.current = Date.now();
        handleHarvestCommand(args, process.cwd()).then((output) => {
          const elapsed = formatElapsed(Date.now() - processingStartRef.current);
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setIsProcessing(false);
          setActiveTools([]);
          setOperationLogs([]);
          setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
        }).catch(err => {
          setIsProcessing(false);
          setActiveTools([]);
          setOperationLogs([]);
          setMessages((prev) => [...prev, createUIMessage("assistant", `Error: ${err.message}`)]);
        });
        break;
      }
      case "guide": {
        setOperationLogs(["Generating guide"]);
        handleGuideCommand().then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setOperationLogs([]);
        });
        break;
      }
      case "enrich": {
        setIsProcessing(true);
        setActiveTools([{ id: "enrich", name: "AI Analysis", isComplete: false }]);
        setOperationLogs([`Enriching wiki with ${activeModel}`, "Analyzing pages"]);
        processingStartRef.current = Date.now();
        handleEnrichCommand(args, process.cwd()).then((output) => {
          const elapsed = formatElapsed(Date.now() - processingStartRef.current);
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setIsProcessing(false);
          setActiveTools([]);
          setOperationLogs([]);
          setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
        }).catch(err => {
          setIsProcessing(false);
          setActiveTools([]);
          setOperationLogs([]);
          setMessages((prev) => [...prev, createUIMessage("assistant", `Error: ${err.message}`)]);
        });
        break;
      }

      case "clear":
        setMessages([]);
        injectedFilesRef.current.clear();
        break;
      case "help":
        setHelpOpen((p) => !p);
        break;
      case "model":
        setMessages((prev) => [
          ...prev,
          createUIMessage(
            "assistant",
            `Active model: **${activeModel}**\nPermission mode: **${permissionMode}**\nChange model via .ccs/config.json`,
          ),
        ]);
        break;
      case "approvals": {
        const pending = getPendingApprovals();
        const content = pending.length === 0
          ? "No pending approvals."
          : [
            `Pending approvals (${pending.length}):`,
            ...pending.map((a) => `• ${a.id} | ${a.toolName} | ${a.riskClass} | ${a.rationale}`),
          ].join("\n");
        setMessages((prev) => [...prev, createUIMessage("assistant", content)]);
        break;
      }
      case "approve": {
        if (!arg) {
          setMessages((prev) => [...prev, createUIMessage("assistant", "Usage: /approve <approval-id>")]);
          break;
        }
        const resolved = resolveApproval(arg, "approved");
        setMessages((prev) => [
          ...prev,
          createUIMessage(
            "assistant",
            resolved
              ? `Approved ${arg} for ${resolved.toolName}.`
              : `Approval id not found: ${arg}`,
          ),
        ]);
        break;
      }
      case "reject": {
        if (!arg) {
          setMessages((prev) => [...prev, createUIMessage("assistant", "Usage: /reject <approval-id>")]);
          break;
        }
        const resolved = resolveApproval(arg, "rejected");
        setMessages((prev) => [
          ...prev,
          createUIMessage(
            "assistant",
            resolved
              ? `Rejected ${arg} for ${resolved.toolName}.`
              : `Approval id not found: ${arg}`,
          ),
        ]);
        break;
      }
      case "tasks": {
        const runs = listAgentRuns();
        const taskLines = runs.length === 0
          ? "No agent runs found."
          : [
              "## Agent Runs",
              "",
              "| ID | Type | Status | Started |",
              "|---|---|---|---|",
              ...runs.map((r) => `| \`${r.id.slice(0, 8)}\` | ${r.agentType} | ${r.status} | ${new Date(r.startedAt).toLocaleTimeString()} |`),
            ].join("\n");
        setMessages((prev) => [...prev, createUIMessage("assistant", taskLines)]);
        break;
      }
      case "mode": {
        const mode = arg as PermissionMode;
        if (mode !== "default" && mode !== "plan" && mode !== "permissive") {
          setMessages((prev) => [...prev, createUIMessage("assistant", "Usage: /mode <default|plan|permissive>")]);
          break;
        }
        setPermissionMode(mode);
        setMessages((prev) => [...prev, createUIMessage("assistant", `Permission mode set to ${mode}.`)]);
        break;
      }
      case "skills":
        setMessages((prev) => [
          ...prev,
          createUIMessage(
            "assistant",
            skills.length > 0
              ? `Loaded skills (${skills.length}):\n${skills.map((s) => `• ${s.name}`).join("\n")}`
              : "No skills loaded. Create `.ccs/skills/*.md` files.",
          ),
        ]);
        break;
      case "hooks": {
        const output = hooksCommandHandler(args);
        setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
        break;
      }
      case "migrate": {
        const subcommand = args[0] ?? "";
        if (!subcommand) {
          setIsMigrateWizard(true);
          setMigrateWizardStep(0);
          setMigrateWizardData({ repo: "", lang: "csharp" });
          setMessages((prev) => [...prev, createUIMessage("assistant", "## 🚀 Migration Wizard  `Esc` to cancel\n\n**Step 1 of 3** — Repository URL\n\nPaste the GitHub URL of the repo you want to analyze:")]);

          break;
        }

        const toolNameMap: Record<string, string> = {
          scan:    "Migration Scanner",
          rewrite: "Code Analyzer",
          status:  "Status Reporter",
          context: "Context Builder",
          verify:  "Claim Verifier",
          done:    "Finalizer",
          rescan:  "Scanner",
          plugin:  "Plugin Loader",
        };

        const toolName = toolNameMap[subcommand] || "Migration Tool";

        setIsProcessing(true);
        setActiveTools([{ id: "migrate-task", name: toolName, details: "Initializing...", isComplete: false }]);
        setMigrateLogs([]);
        processingStartRef.current = Date.now();

        handleMigrateCommand(args, process.cwd(), (msg) => {
          setActiveTools([{ id: "migrate-task", name: toolName, details: msg, isComplete: false }]);
        })
          .then((output) => {
            const elapsed = formatElapsed(Date.now() - processingStartRef.current);
            setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
            setIsProcessing(false);
            setActiveTools([]);
            setMigrateLogs([]);
            setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            setMessages((prev) => [...prev, createUIMessage("assistant", `Error: ${msg}`)]);
            setIsProcessing(false);
            setActiveTools([]);
            setMigrateLogs([]);
          });
        break;
      }
      case "exit":
        exit();
        break;
      case "setup":
      case "mcp-setup": {
        const setupOutput = [
          "## Wire Codex or Claude Code to CCS",
          "",
          "CCS exposes a local MCP server that lets your coding agent read migration artifacts (ready work, verification, business logic, system graph, code intelligence, dependency impact, and search) directly. Start it with:",
          "",
          "```",
          "ccs-code mcp",
          "```",
          "",
          "### Codex CLI / Codex Desktop",
          "",
          "Register CCS once. Codex remembers it across sessions:",
          "",
          "```",
          "codex mcp add ccs -- ccs-code mcp",
          "```",
          "",
          "Then in Codex you can ask things like:",
          "",
          "> Use the `ccs` MCP. Call `ccs_list_ready_components`, then for the first ready component call `ccs_get_component_context` and `ccs_get_verification_report`. Stop and report if `implementationStatus` is `needs_review`.",
          "",
          "### Claude Code",
          "",
          "Add CCS to your project's `.mcp.json`:",
          "",
          "```json",
          "{",
          "  \"mcpServers\": {",
          "    \"ccs\": {",
          "      \"command\": \"ccs-code\",",
          "      \"args\": [\"mcp\"]",
          "    }",
          "  }",
          "}",
          "```",
          "",
          "Then call any of these tools from Claude Code:",
          "",
          "- `ccs_list_ready_components` — components that passed verification and are safe for an agent to implement",
          "- `ccs_get_component_context` — full source-backed context for one component",
          "- `ccs_get_verification_report` — per-claim audit and trust verdict",
          "- `ccs_get_human_questions` — unresolved architecture decisions",
          "- `ccs_get_validation_contract` — gates, acceptance criteria, validation scenarios",
          "- `ccs_get_architecture_baseline` — target landing-zone profile",
          "- `ccs_get_business_logic` — reverse-engineered rules and contracts",
          "- `ccs_get_system_graph` — components, files, symbols, calls, packages, target roles, edges",
          "- `ccs_get_code_intelligence` — lightweight symbol and call-map artifact",
          "- `ccs_get_dependency_impact` — dependencies, transitive impact, calls, and retest scope",
          "- `ccs_search_artifacts` — search CCS markdown/JSON reports by business or code term",
          "- `ccs_get_preflight_readiness` — readiness gates before implementation",
          "- `ccs_get_dependency_risk_report` — package inventory, security-sensitive packages, optional advisory hits",
          "- `ccs_get_test_scaffolds` — parity-test starting points generated from validation scenarios",
          "",
          "### Optional enterprise knobs",
          "",
          "Use a different verifier model/provider to reduce shared blind spots between the analyzer and trust gate:",
          "",
          "```json",
          "{",
          "  \"provider\": \"codex_cli\",",
          "  \"model\": \"default\",",
          "  \"verifier_provider\": \"anthropic\",",
          "  \"verifier_model_flash\": \"claude-haiku-4-5-20251001\"",
          "}",
          "```",
          "",
          "Enable OSV package advisory lookup only when network policy allows it:",
          "",
          "```",
          "CCS_ENABLE_ADVISORY_LOOKUP=true",
          "```",
          "",
          "Optional multi-language AST parsing: JS/TS uses the built-in TypeScript parser. For Python, Java, C#, and Go, install Tree-sitter packages from your approved npm registry. CCS will use them automatically when the native binding is available and fall back safely when it is not:",
          "",
          "```",
          "npm install --save-optional tree-sitter tree-sitter-python tree-sitter-java tree-sitter-c-sharp tree-sitter-go",
          "npm rebuild tree-sitter",
          "```",
          "",
          "### Recommended workflow",
          "",
          "1. Run `/migrate rewrite --repo <url> --to <language> --context docs/your-baseline.md --yes`",
          "2. Open the generated view with `/migrate open --dashboard`, or open the result folder with `/migrate open`",
          "3. Review `verification-summary.md` and resolve `human-questions.md` before coding",
          "4. Hand the work to Codex or Claude Code via MCP — they only pick up `ready` components",
          "5. After implementation, validate against `validationScenarios` from the contract",
          "",
          "_Run `/guide` for the full interactive walkthrough._",
        ].join("\n");
        setMessages((prev) => [...prev, createUIMessage("assistant", setupOutput)]);
        break;
      }
      default:
        setMessages((prev) => [...prev, createUIMessage("assistant", `Unknown command: /${id}`)]);
        break;
    }
  };

  const handleSetupSubmit = async (path: string) => {
    const cleanPath = path.trim().replace(/^['"]|['"]$/g, "");
    const resolvedPath = resolve(process.cwd(), cleanPath);

    // 1. Initialize the vault folders immediately
    try {
      await initVault(resolvedPath);
    } catch (e) {
      // If we can't create the folder, we'll still save the config but the user might see errors later
    }

    // 2. Save as active vault
    await saveVaultConfig({ activeVault: resolvedPath });
    setVaultPath(resolvedPath);

    // 3. Show success guidance
    setSetupStep("success");
  };

  const handleSetupDone = () => {
    setIsSetupMode(false);
    triggerBoot();
  };

  const handleMigrateWizardSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setMessages((prev) => [...prev, createUIMessage("user", trimmed)]);

    if (migrateWizardStep === 0) {
      // Step 1 — Repository URL
      // Basic URL validation
      const isUrl = /^https?:\/\//i.test(trimmed) || /^[\w.-]+\/[\w.-]+$/.test(trimmed);
      if (!isUrl) {
        setMessages((prev) => [
          ...prev,
          createUIMessage("assistant", `⚠ That doesn't look like a valid URL. Please enter a GitHub URL, e.g.\n\`https://github.com/org/repo\``),
        ]);
        return;
      }
      setMigrateWizardData((prev) => ({ ...prev, repo: trimmed }));
      setMigrateWizardStep(1);
      setMessages((prev) => [
        ...prev,
        createUIMessage(
          "assistant",
          "**Step 2 of 3** — Target language\n\nWhat language or framework are you migrating **to**?\n\nExamples: `csharp`, `typescript`, `python`, `java`, `go`\nOr describe it: `.net entity framework`, `spring boot`, `fastapi`\n\nPress Enter to use the default: `csharp`",
        ),
      ]);
    } else if (migrateWizardStep === 1) {
      // Step 2 — Language (accept free-form, normalise via alias map)
      const raw = trimmed || "csharp";
      const normalised = normaliseLang(raw);
      setMigrateWizardData((prev) => ({ ...prev, lang: normalised }));
      setMigrateWizardStep(2);
      const displayLang = normalised !== raw.toLowerCase().trim() ? `${normalised} (from "${raw}")` : normalised;
      setMessages((prev) => [
        ...prev,
        createUIMessage(
          "assistant",
          `**Step 3 of 3** — Confirm\n\n| | |\n|---|---|\n| **Repo** | \`${migrateWizardData.repo}\` |\n| **Target** | \`${displayLang}\` |\n| **Mode** | Full code analysis + migration contract |\n\nType \`y\` to start · \`n\` to cancel`,
        ),
      ]);
    } else if (migrateWizardStep === 2) {
      // Step 3 — Confirmation
      const confirm = trimmed.toLowerCase();
      if (confirm === "y" || confirm === "yes") {
        setIsMigrateWizard(false);
        // Use `migrate rewrite` (general analysis) not `migrate scan` (SOAP-only)
        const cmd = `migrate rewrite --repo ${migrateWizardData.repo} --to ${migrateWizardData.lang} --yes`;
        setMessages((prev) => [
          ...prev,
          createUIMessage("assistant", `Starting analysis of \`${migrateWizardData.repo}\`...\n\nThis clones the repo, maps the architecture, and generates a migration contract. May take 1–3 minutes.`),
        ]);
        executeSlashCommand(cmd);
      } else {
        setIsMigrateWizard(false);
        setMessages((prev) => [...prev, createUIMessage("assistant", "Migration wizard cancelled. Run `/migrate` to start again.")]);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(
    async (value: string) => {
      // If a suggestion is highlighted, Tab/Enter should apply it, not submit
      if (suggestionMode && suggestions.length > 0) {
        applySuggestion(suggestions[selectedIdx]);
        return;
      }

      const trimmed = value.trim();
      if (!trimmed) return;

      if (isMigrateWizard) {
        handleMigrateWizardSubmit(trimmed);
        setInput("");
        return;
      }

      setShowWelcome(false);

      // Plain slash commands typed and submitted
      if (trimmed.startsWith("/")) {
        setMessages((prev) => [...prev, createUIMessage("user", trimmed)]);
        executeSlashCommand(trimmed.slice(1));
        setInput("");
        return;
      }

      // ----- Pending migration: user is answering a "what target language?" prompt -----
      if (pendingMigration) {
        const reply = trimmed.toLowerCase();
        if (reply === "cancel" || reply === "no" || reply === "stop") {
          setPendingMigration(null);
          setMessages((prev) => [
            ...prev,
            createUIMessage("user", trimmed),
            createUIMessage("assistant", "Cancelled. No migration started."),
          ]);
          setInput("");
          return;
        }
        // Treat short replies as a target-language answer.
        const candidate = trimmed.split(/\s+/)[0] ?? "";
        if (candidate && isSupportedTargetLanguage(candidate)) {
          const lang = normaliseLang(candidate);
          const completed: RouterDecision = {
            ...pendingMigration,
            targetLanguage: lang,
            targetLanguageWasInferred: false,
          };
          const command = decisionToSlashCommand(completed);
          setPendingMigration(null);
          setMessages((prev) => [
            ...prev,
            createUIMessage("user", trimmed),
            createUIMessage("assistant", formatRouterAck(completed)),
          ]);
          setInput("");
          if (command) executeSlashCommand(command);
          return;
        }
        setMessages((prev) => [
          ...prev,
          createUIMessage("user", trimmed),
          createUIMessage(
            "assistant",
            "I didn't recognise that as a target language. Reply with one of: `csharp`, `typescript`, `python`, `java`, `go`, `ruby`, `rust`, `php`, `swift`, `kotlin`. Or type `cancel` to drop it.",
          ),
        ]);
        setInput("");
        return;
      }

      // ----- Fresh natural-language input: try to detect utility intents -----
      // These are the "Codex/Claude-style" convenience routes around a run:
      // open the latest dashboard, show status, connect MCP, open help, etc.
      // Run these before migration detection so "open dashboard for <repo URL>"
      // is not mistaken for "migrate <repo URL>".
      const toolDecision = routeToolIntent(trimmed);
      if (toolDecision) {
        setMessages((prev) => [
          ...prev,
          createUIMessage("user", trimmed),
          createUIMessage("assistant", formatToolIntentAck(toolDecision)),
        ]);
        setInput("");
        executeSlashCommand(toolDecision.command);
        return;
      }

      // ----- Fresh natural-language input: try to detect migration intent -----
      const migrationDecision = await routeIntent(trimmed);
      if (migrationDecision) {
        const command = decisionToSlashCommand(migrationDecision);
        if (command) {
          // High enough confidence — auto-execute. Show a one-line ack so the
          // user can see what we ran on their behalf.
          setMessages((prev) => [
            ...prev,
            createUIMessage("user", trimmed),
            createUIMessage("assistant", formatRouterAck(migrationDecision)),
          ]);
          setInput("");
          executeSlashCommand(command);
          return;
        }
        // Repo is clear but target language is missing — ask one short question
        // and stash the partial decision so the next reply completes it.
        setPendingMigration(migrationDecision);
        setMessages((prev) => [
          ...prev,
          createUIMessage("user", trimmed),
          createUIMessage("assistant", formatRouterClarification(migrationDecision)),
        ]);
        setInput("");
        return;
      }

      // Build the final message: inline content from injected @files and pasted blocks
      let finalContent = trimmed;
      
      // 1. Expand pasted blocks [Pasted Text: N lines]
      const pastedBlocks = pastedBlocksRef.current;
      for (const [token, content] of pastedBlocks.entries()) {
        if (finalContent.includes(token)) {
          finalContent = finalContent.replace(token, `\n\n[Pasted Content]\n\`\`\`\n${content}\n\`\`\``);
        }
      }
      pastedBlocks.clear();

      // 2. Expand @file blocks
      const injected = injectedFilesRef.current;
      if (injected.size > 0) {
        const fileBlocks = Array.from(injected.entries())
          .map(([path, content]) => {
            // Only include if the file tag is still in the input
            if (trimmed.includes(`@${path}`)) {
              return `\n\n[File: ${path}]\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
            }
            return "";
          })
          .join("");
        finalContent = finalContent + fileBlocks;
        injected.clear();
      }

      const userMsg: UIMessage = createUIMessage("user", trimmed); // display without file blobs
      setMessages((prev) => [...prev, userMsg]);
      setInput("");

      // Send the full content (including file blobs) to the LLM
      const history: Message[] = [
        ...messages,
        { role: "user", content: finalContent },
      ];
      sendToLLM(history);
    },
    [
      suggestionMode,
      suggestions,
      selectedIdx,
      messages,
      skills,
      activeModel,
      isMigrateWizard,
      handleMigrateWizardSubmit,
    ],
  );

  // Execute initialPrompt if provided on boot
  useEffect(() => {
    if (initialPrompt && orchestratorRef.current) {
      // Small delay to ensure boot is fully settled and messages are ready
      const timer = setTimeout(() => {
        handleSubmit(initialPrompt);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [initialPrompt, handleSubmit, triggerBoot]);

  // ---------------------------------------------------------------------------
  // LLM call
  // ---------------------------------------------------------------------------

  const sendToLLM = async (history: Message[]) => {
    const provider = providerRef.current;
    if (!provider) {
      setMessages((prev) => [
        ...prev,
        createUIMessage("assistant", "⚠️  No LLM provider. Check .ccs/config.json and .env."),
      ]);
      return;
    }

    setIsProcessing(true);
    setIsStalled(false);
    setCompletionLabel(null);
    setActiveTools([{ id: "1", name: `Sending to ${provider.name}...`, isComplete: false }]);
    setOperationLogs([`Sending to ${provider.name}`, "Waiting for response"]);
    processingStartRef.current = Date.now();

    const stallTimer = setTimeout(() => setIsStalled(true), 10_000);

    try {
      const orchestrator = orchestratorRef.current;
      const output = orchestrator
        ? await orchestrator.run({
          cwd: process.cwd(),
          history,
          systemPrompt: systemPromptRef.current || "",
          permissionMode,
        })
        : {
          response: await provider.chat(history, systemPromptRef.current || undefined),
          usedTools: [],
          startedAgentRunIds: [],
          logs: [],
        };

      clearTimeout(stallTimer);
      if (output.usedTools.length > 0) {
        setActiveTools(
          output.usedTools.map((toolName, index) => ({
            id: `${index + 1}`,
            name: `Executed ${toolName}`,
            isComplete: true,
          })),
        );
        setOperationLogs(output.usedTools.map((toolName) => `✓ Executed ${toolName}`));
      } else {
        setActiveTools((t) => t.map((tool) => ({ ...tool, isComplete: true })));
        setOperationLogs(["✓ Response ready"]);
      }

      const elapsed = formatElapsed(Date.now() - processingStartRef.current);
      setTimeout(() => {
        setMessages((prev) => [...prev, createUIMessage("assistant", output.response)]);
        setActiveTools([]);
        setOperationLogs([]);
        setIsProcessing(false);
        setIsStalled(false);
        setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
      }, 300);
    } catch (e) {
      clearTimeout(stallTimer);
      const elapsed = formatElapsed(Date.now() - processingStartRef.current);
      const errorMsg = e instanceof Error ? e.message : String(e);
      setActiveTools([]);
      setOperationLogs([]);
      setIsProcessing(false);
      setIsStalled(false);
      setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
      setMessages((prev) => [...prev, createUIMessage("assistant", formatError(errorMsg))]);
    }
  };

  // ---------------------------------------------------------------------------
  // Global Expansion Logic (ctrl+o)
  // ---------------------------------------------------------------------------
  const [areLogsExpanded, setAreLogsExpanded] = useState(false);

  // ---------------------------------------------------------------------------
  // Global Cancel Logic
  // ---------------------------------------------------------------------------
  const cancelOperation = useCallback(() => {
    if (!isProcessing) return;
    setIsProcessing(false);
    setIsStalled(false);
    setActiveTools([]);
    setOperationLogs([]);
    setMigrateLogs(prev => [...prev, "✗ Operation cancelled by user."]);
  }, [isProcessing]);

  // Listen for global keys
  useInput((input, key) => {
    if ((input === "u" && key.ctrl) || (input === "l" && key.ctrl)) {
      if (isSetupMode) {
        setSetupInput("");
        return;
      }
      setInput("");
      setInputKey((k) => k + 1);
      return;
    }

    if (key.escape) {
      cancelOperation();
    }
    // ctrl+o to toggle log expansion
    if (input === "o" && key.ctrl) {
      setAreLogsExpanded(prev => !prev);
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (isSetupMode) {
    const boxWidth = Math.max(42, terminalWidth - 4);

    if (setupStep === "success") {
      return (
        <Box
          flexDirection="column"
          padding={2}
          borderStyle="round"
          borderColor="green"
          width={boxWidth}
          marginX={2}
          marginTop={1}
        >
          <Box marginBottom={1} alignItems="center" flexDirection="column">
            <Text bold color="green">✓ Vault Initialized!</Text>
            <Text dimColor>{vaultPath}</Text>
          </Box>

          <Box flexDirection="column" marginBottom={1}>
            <Text>I've created the folder structure for your knowledge base.</Text>
            
            <Box marginTop={1} flexDirection="column">
              <Text bold>Next Step:</Text>
              <Box marginLeft={2} flexDirection="column">
                <Text color="cyan">1. Drop your files into: raw/uploads/</Text>
                <Text dimColor>2. Restart the app</Text>
                <Text dimColor>3. Run /ingest to build your wiki</Text>
              </Box>
            </Box>
          </Box>

          <Box
            marginTop={1}
            borderStyle="single"
            borderTop={true}
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
            borderColor="gray"
            paddingTop={1}
            flexDirection="row"
            gap={1}
          >
            <Text dimColor>Press </Text>
            <Box>
              <TextInput
                value=""
                onChange={() => {}}
                onSubmit={handleSetupDone}
                placeholder="Enter"
              />
            </Box>
            <Text dimColor> to continue to chat...</Text>
          </Box>
        </Box>
      );
    }

    return (
      <Box
        flexDirection="column"
        padding={2}
        borderStyle="round"
        borderColor="cyan"
        width={boxWidth}
        marginX={2}
        marginTop={1}
      >
        <Box marginBottom={1} alignItems="center" flexDirection="column">
          <Text bold color="cyan">Welcome to CCS Code!</Text>
          <Text dimColor>Your AI-powered knowledge base</Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text>Where should we store your knowledge base (vault)?</Text>
          <Text dimColor>(e.g. ./vault, ~/Documents/knowledge, or C:\Users\me\Documents\knowledge)</Text>
        </Box>

        <Box flexDirection="row" gap={1}>
          <Text bold color="yellow">❯</Text>
          <TextInput
            value={setupInput}
            onChange={(val) => { 
              activeInputRef.current = "setup"; 
              setSetupInput(val.replace(/\\\//g, "/").replace(/\\ /g, " ")); 
            }}
            onSubmit={handleSetupSubmit}
            placeholder="Enter absolute or relative path..."
          />
        </Box>

        <Box marginTop={1} borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray" paddingTop={1}>
          <Text dimColor>This path will be saved to ccsconfig.json</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Scrollback History */}
      <Static items={messages}>
        {(msg) => {
          return (
            <Box key={msg.id} flexDirection="column" marginTop={1} paddingX={2}>
              {msg.role === "user" ? (
                <UserPromptBlock content={msg.content} width={terminalWidth - 4} />
              ) : (
                <AssistantMessageBlock content={msg.content} width={terminalWidth - 4} />
              )}
            </Box>
          );
        }}
      </Static>

      {/* Main Active Body */}
      <Box flexDirection="column" paddingX={1}>
        {/* Welcome screen */}
        {showWelcome && (
          <WelcomeBox
            activeModel={activeModel}
            workspacePath={process.cwd()}
          />
        )}

        {/* Tool Result Cards */}
        {activeTools.map((tool) => {
          const name = tool.name;
          const details = tool.details || (tool.isComplete ? "Success" : "Processing...");
          
          return (
            <ToolBlock
              key={tool.id}
              name={name}
              status={tool.isComplete ? "Done" : "Working"}
              details={details}
              isComplete={tool.isComplete}
              width={terminalWidth - 4}
            />
          );
        })}

        {/* Migration scan live log (fallback for legacy or deep logs) */}
        {!isProcessing && migrateLogs.length > 0 && (
          <Box flexDirection="column" marginTop={1} paddingLeft={1}>
            <ScanProgressLog
              logs={migrateLogs}
              isExpanded={areLogsExpanded}
              showSpinnerForLast={false}
              modelLabel={activeModel}
              width={terminalWidth - 4}
            />
          </Box>
        )}
      </Box>

      {/* Input Area */}
      <Box flexDirection="column" marginTop={1}>
        {isProcessing && <ThinkingBlock startTime={processingStartRef.current} />}

        <Box
          flexDirection="row"
          gap={1}
          paddingX={1}
          paddingY={1}
          width={terminalWidth}
          backgroundColor="#30343d"
          marginTop={1}
        >
          <Text bold color="#aeb7d6">›</Text>
          <Box flexGrow={1}>
            <TextInput
              key={inputKey}
              value={input}
              focus={!isProcessing}
              onChange={(val) => {
                activeInputRef.current = isMigrateWizard ? "wizard" : "main";
                handleInputChange(val);
              }}
              onSubmit={handleSubmit}
            />
            {input === "" && (
              <Box position="absolute" marginLeft={1}>
                {isProcessing ? (
                  <Box gap={1}>
                    <Text color="#718096">Type your message or @path/to/file</Text>
                  </Box>
                ) : (
                  <Text dimColor>
                    {isMigrateWizard
                      ? migrateWizardStep === 0
                        ? "https://github.com/org/repo"
                        : migrateWizardStep === 1
                        ? "e.g. csharp, typescript, python  (Enter for default)"
                        : "y / n"
                      : "Type your message or @path/to/file"}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        </Box>

        {/* Autocomplete */}
        {suggestionMode && suggestions.length > 0 && !isProcessing && (
          <SuggestionList
            items={suggestions}
            selectedIndex={selectedIdx}
            mode={suggestionMode}
            terminalWidth={terminalWidth}
          />
        )}

        {/* New Multi-column Footer */}
        <MainFooter 
          workspacePath={process.cwd()}
          activeModel={activeModel}
          permissionMode={permissionMode}
          columns={terminalWidth}
          skillsCount={skills.length}
          instructionsCount={instructions.length}
          vaultPath={vaultPath}
        />
      </Box>
    </Box>
  );
}
