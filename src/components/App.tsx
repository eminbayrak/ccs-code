import React, { useState, useEffect, useRef, useCallback } from "react";
import { Text, Box, useApp, useInput, Static } from "ink";
import TextInput from "ink-text-input";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { join, resolve } from "path";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { CCSSpinner } from "./animations/CCSSpinner";
import { AgentProgressLine } from "./animations/AgentProgressLine";
import { StatusBar } from "./StatusBar";
import { HelpMenu } from "./HelpMenu";
import { WelcomeBox, LOGO_LARGE, LOGO_SMALL } from "./WelcomeBox";
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
  isComplete: boolean;
};

type SuggestionMode = "file" | "command" | null;

// ---------------------------------------------------------------------------
// Slash Commands registry
// ---------------------------------------------------------------------------

const SLASH_COMMANDS: SuggestionItem[] = [
  // CCS Code vault commands
  { id: "vault", label: "/vault <init|status|audit>", description: "Initialize, inspect, or audit the CCS Code vault" },
  { id: "sync", label: "/sync", description: "Sync configured sources (GitHub, Confluence) into raw/" },
  { id: "ingest", label: "/ingest", description: "Process raw/ files into wiki pages" },
  { id: "graph", label: "/graph", description: "Build interactive knowledge graph (pyvis)" },
  { id: "lint", label: "/lint", description: "Run wiki health checks (broken links, orphans, staleness)" },
  { id: "rewrite", label: "/rewrite <service|order>", description: "Generate rewrite brief or system-wide rewrite order" },
  { id: "index", label: "/index", description: "Rebuild wiki/_master-index.md" },
  { id: "enrich", label: "/enrich", description: "Use AI to add summaries, tags, and links to wiki pages" },
  { id: "ask", label: "/ask <question>", description: "Ask a question answered from your wiki knowledge base" },
  { id: "harvest", label: "/harvest", description: "Mine AI chat logs (Claude, Cursor, Copilot) into the vault" },
  { id: "guide", label: "/guide", description: "Open interactive how-to guide with diagrams in browser" },
  { id: "migrate", label: "/migrate <scan|status|context|verify>", description: "Scan a legacy codebase and generate AI rewrite context" },
  // Core commands
  { id: "clear", label: "/clear", description: "Clear conversation history" },
  { id: "skills", label: "/skills", description: "List loaded skills" },
  { id: "model", label: "/model", description: "Show active model" },
  { id: "approvals", label: "/approvals", description: "List pending approvals" },
  { id: "approve", label: "/approve <id>", description: "Approve a pending action" },
  { id: "reject", label: "/reject <id>", description: "Reject a pending action" },
  { id: "tasks", label: "/tasks", description: "List background agent tasks" },
  { id: "mode", label: "/mode <default|plan|permissive>", description: "Set permission mode" },
  { id: "hooks", label: "/hooks <list|enable|disable|clear>", description: "Manage event hooks" },
  { id: "help", label: "/help", description: "Toggle keyboard shortcuts" },
  { id: "exit", label: "/exit", description: "Exit CCS Code" },
];

function filterCommands(query: string): SuggestionItem[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.label.includes(q));
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
  const after = value.slice(1);
  if (after.includes(" ")) return null;
  return { query: after };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Divider({ width }: { width: number }) {
  return <Text dimColor>{"─".repeat(Math.max(1, width))}</Text>;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

const DONE_VERBS = ["Cooked", "Brewed", "Crunched", "Synthesized", "Distilled", "Crafted", "Wrangled", "Baked"];
let doneVerbIdx = 0;
function nextDoneVerb() {
  return DONE_VERBS[doneVerbIdx++ % DONE_VERBS.length]!;
}

export function App({ initialPrompt }: { initialPrompt?: string; }) {
  const { exit } = useApp();
  const { columns: terminalWidth } = useTerminalSize();

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
    if (!vaultCfg.activeVault) {
      setIsSetupMode(true);
      setActiveModel("Waiting for setup...");
      return;
    }
    setVaultPath(vaultCfg.activeVault);

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
      setInput(value);
      setSelectedIdx(0);

      // Claude-like help behavior: show help only while the input is exactly '?'.
      const isHelpTrigger = value.trim() === "?";
      if (!isProcessing) {
        if (isHelpTrigger && !helpOpen) setHelpOpen(true);
        if (!isHelpTrigger && helpOpen) setHelpOpen(false);
      }

      // --- @ file trigger ---
      const atResult = detectAtTrigger(value);
      if (atResult) {
        setSuggestionMode("file");
        setAtTriggerStart(atResult.triggerStart);
        const matched = filterFiles(allFilesRef.current, atResult.query);
        setSuggestions(matched.map((f) => ({ id: f.path, label: f.path })));
        return;
      }

      // --- / command trigger ---
      const slashResult = detectSlashTrigger(value);
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
        // Commands that require arguments should populate the input for editing.
        if (item.id === "approve" || item.id === "reject" || item.id === "mode" || item.id === "vault" || item.id === "rewrite" || item.id === "ask" || item.id === "migrate") {
          setInput(`/${item.id} `);
          setInputKey((k) => k + 1);
        } else {
          executeSlashCommand(item.id);
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

    switch (id) {
      // ------------------------------------------------------------------
      // CCS Code vault commands
      // ------------------------------------------------------------------
      case "vault": {
        handleVaultCommand(args, process.cwd()).then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
        });
        setMessages((prev) => [...prev, createUIMessage("assistant", "Running /vault...")]);
        break;
      }
      case "sync": {
        setIsProcessing(true);
        setActiveTools([{ id: "sync", name: "Syncing sources", isComplete: false }]);
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
        setMessages((prev) => [...prev, createUIMessage("assistant", "Syncing sources...")]);
        break;
      }
      case "ingest": {
        setIsProcessing(true);
        setActiveTools([{ id: "ingest", name: "Processing raw files", isComplete: false }]);
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
        setMessages((prev) => [...prev, createUIMessage("assistant", "Scanning raw/ inbox...")]);
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
        handleIndexCommand(args, process.cwd()).then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
        });
        setMessages((prev) => [...prev, createUIMessage("assistant", "Rebuilding master index...")]);
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
        processingStartRef.current = Date.now();
        handleAskCommand(question, process.cwd()).then((output) => {
          const elapsed = formatElapsed(Date.now() - processingStartRef.current);
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
          setActiveTools([]);
          setIsProcessing(false);
          setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
        });
        break;
      }
      case "harvest": {
        setIsProcessing(true);
        setActiveTools([{ id: "harvest", name: "Mining AI logs", isComplete: false }]);
        processingStartRef.current = Date.now();
        handleHarvestCommand(args, process.cwd()).then((output) => {
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
        setMessages((prev) => [...prev, createUIMessage("assistant", "Mining local AI histories (Claude, Cursor, VS Code)...")]);
        break;
      }
      case "guide": {
        handleGuideCommand().then((output) => {
          setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
        });
        setMessages((prev) => [...prev, createUIMessage("assistant", "Generating guide…")]);
        break;
      }
      case "enrich": {
        setIsProcessing(true);
        setActiveTools([{ id: "enrich", name: "AI Analysis", isComplete: false }]);
        processingStartRef.current = Date.now();
        setMessages((prev) => [...prev, createUIMessage("assistant", `Enriching wiki with ${activeModel}...\nThis runs AI analysis on each page — may take a few minutes.`)]);
        handleEnrichCommand(args, process.cwd()).then((output) => {
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
        const content = runs.length === 0
          ? "No agent tasks yet."
          : [
            `Agent tasks (${runs.length}):`,
            ...runs.map((r) => `• ${r.id} | ${r.agentType} | ${r.status}${r.error ? ` | error: ${r.error}` : ""}`),
          ].join("\n");
        setMessages((prev) => [...prev, createUIMessage("assistant", content)]);
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
          setMessages((prev) => [...prev, createUIMessage("assistant", "### 🚀 Migration Wizard\n\nI'll help you set up a migration scan. (Press `Esc` to cancel)\n\nFirst, enter the **repository URL** you want to scan:")]);
          break;
        }

        const toolNameMap: Record<string, string> = {
          scan:    "Scanning repository",
          rewrite: "Analyzing codebase",
          status:  "Fetching status",
          context: "Loading context",
          verify:  "Verifying service",
          done:    "Finalizing service",
          rescan:  "Preparing rescan",
          plugin:  "Loading plugins",
        };

        const startMsgMap: Record<string, string> = {
          scan:    "Starting migration scan — this may take several minutes...",
          rewrite: "Analyzing codebase for migration — this may take several minutes...",
          status:  "Loading migration status...",
          context: "Loading context doc...",
          verify:  "Processing verification...",
          done:    "Marking service as done...",
          rescan:  "Preparing rescan instructions...",
          plugin:  "Listing installed plugins...",
        };

        const startMsg = startMsgMap[subcommand] ?? `Running /migrate ${subcommand}...`;
        const toolName = toolNameMap[subcommand] ?? `Executing migrate ${subcommand}`;

        setMessages((prev) => [...prev, createUIMessage("assistant", startMsg)]);
        setIsProcessing(true);
        setActiveTools([{ id: "migrate-task", name: toolName, isComplete: false }]);
        processingStartRef.current = Date.now();

        handleMigrateCommand(args, process.cwd(), (msg) => {
          setActiveTools([{ id: "migrate-task", name: msg, isComplete: false }]);
        })
          .then((output) => {
            const elapsed = formatElapsed(Date.now() - processingStartRef.current);
            setMessages((prev) => [...prev, createUIMessage("assistant", output)]);
            setIsProcessing(false);
            setActiveTools([]);
            setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            setMessages((prev) => [...prev, createUIMessage("assistant", `Error: ${msg}`)]);
            setIsProcessing(false);
            setActiveTools([]);
          });
        break;
      }
      case "exit":
        exit();
        break;
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
      // Repository URL
      setMigrateWizardData((prev) => ({ ...prev, repo: trimmed }));
      setMigrateWizardStep(1);
      setMessages((prev) => [
        ...prev,
        createUIMessage("assistant", "Target language? (e.g., `csharp`, `typescript`, `python`. Default: `csharp`)"),
      ]);
    } else if (migrateWizardStep === 1) {
      // Language
      const lang = trimmed.toLowerCase() || "csharp";
      setMigrateWizardData((prev) => ({ ...prev, lang }));
      setMigrateWizardStep(2);
      setMessages((prev) => [
        ...prev,
        createUIMessage("assistant", `Ready to scan **${migrateWizardData.repo}** for **${lang}** migration.\n\nProceed? (y/n)`),
      ]);
    } else if (migrateWizardStep === 2) {
      // Confirmation
      if (trimmed.toLowerCase() === "y" || trimmed.toLowerCase() === "yes") {
        setIsMigrateWizard(false);
        const cmd = `migrate scan --repo ${migrateWizardData.repo} --lang ${migrateWizardData.lang} --yes`;
        executeSlashCommand(cmd);
      } else {
        setIsMigrateWizard(false);
        setMessages((prev) => [...prev, createUIMessage("assistant", "Migration scan cancelled.")]);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(
    (value: string) => {
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
        executeSlashCommand(trimmed.slice(1));
        setInput("");
        return;
      }

      // Build the final message: inline content from injected @files
      let finalContent = trimmed;
      const injected = injectedFilesRef.current;
      if (injected.size > 0) {
        const fileBlocks = Array.from(injected.entries())
          .map(([path, content]) =>
            `\n\n[File: ${path}]\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``,
          )
          .join("");
        finalContent = trimmed + fileBlocks;
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
      } else {
        setActiveTools((t) => t.map((tool) => ({ ...tool, isComplete: true })));
      }

      const elapsed = formatElapsed(Date.now() - processingStartRef.current);
      setTimeout(() => {
        setMessages((prev) => [...prev, createUIMessage("assistant", output.response)]);
        setActiveTools([]);
        setIsProcessing(false);
        setIsStalled(false);
        setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
      }, 300);
    } catch (e) {
      clearTimeout(stallTimer);
      const elapsed = formatElapsed(Date.now() - processingStartRef.current);
      const errorMsg = e instanceof Error ? e.message : String(e);
      setActiveTools([]);
      setIsProcessing(false);
      setIsStalled(false);
      setCompletionLabel(`${nextDoneVerb()} for ${elapsed}`);
      setMessages((prev) => [...prev, createUIMessage("assistant", `❌ Error: ${errorMsg}`)]);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const dividerWidth = Math.max(1, terminalWidth - 4);

  if (isSetupMode) {
    const boxWidth = Math.max(42, terminalWidth - 4);
    const showLargeLogo = boxWidth >= 40;

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
        {/* Logo */}
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          {(showLargeLogo ? LOGO_LARGE : LOGO_SMALL).map((line, i) => (
            <Text key={i} color="cyan">{line}</Text>
          ))}
        </Box>

        <Box marginBottom={1} alignItems="center" flexDirection="column">
          <Text bold color="cyan">Welcome to CCS Code!</Text>
          <Text dimColor>Your AI-powered knowledge base</Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text>Where should we store your knowledge base (vault)?</Text>
          <Text dimColor>(e.g. ./vault or /Users/me/Documents/knowledge)</Text>
        </Box>

        <Box flexDirection="row" gap={1}>
          <Text bold color="yellow">❯</Text>
          <TextInput
            value={setupInput}
            onChange={setSetupInput}
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
      {/* Messages — printed into terminal scrollback, never re-rendered */}
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.id} flexDirection="column" marginTop={1} paddingX={2}>
            {msg.role === "user" ? (
              <Box backgroundColor="gray" paddingX={1}>
                <Text color="white">{msg.content}</Text>
              </Box>
            ) : (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color="yellow">◆</Text>
                  <Text bold color="white">CCS Code</Text>
                </Box>
                <Box paddingLeft={2} flexDirection="column">
                  <MarkdownText content={msg.content} width={terminalWidth - 6} />
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Static>

      {/* Welcome screen — shown until user sends first message */}
      {showWelcome && (
        <WelcomeBox
          activeModel={activeModel}
          workspacePath={process.cwd()}
        />
      )}

      {/* Spinner line (while processing) or completion label (after done) */}
      <Box paddingX={1} marginTop={1}>
        {isProcessing ? (
          <Box flexDirection="column">
            <CCSSpinner isStalled={isStalled} />
            {activeTools.map((tool) => (
              <AgentProgressLine key={tool.id} taskName={tool.name} isComplete={tool.isComplete} />
            ))}
          </Box>
        ) : completionLabel ? (
          <Box flexDirection="row" gap={1}>
            <Text color="green">✻</Text>
            <Text dimColor>{completionLabel}</Text>
          </Box>
        ) : (
          <Text> </Text>
        )}
      </Box>

      {/* Top divider */}
      <Box paddingX={1}>
        <Divider width={dividerWidth} />
      </Box>

      {/* Input area */}
      <Box flexDirection="column" paddingX={1}>
        {/* Suggestion list floats above input */}
        {!isProcessing && suggestionMode && suggestions.length > 0 && (
          <SuggestionList
            items={suggestions}
            selectedIndex={selectedIdx}
            mode={suggestionMode}
          />
        )}

        {/* Input row */}
        <Box flexDirection="row" gap={1}>
          <Text bold color={isProcessing ? "gray" : suggestionMode ? "cyan" : "white"}>❯</Text>
          {isProcessing ? (
            <Text dimColor> </Text>
          ) : (
            <TextInput
              key={inputKey}
              value={input}
              onChange={handleInputChange}
              onSubmit={handleSubmit}
              placeholder={
                isMigrateWizard
                  ? migrateWizardStep === 0
                    ? "https://github.com/org/repo"
                    : migrateWizardStep === 1
                    ? "csharp, typescript, python..."
                    : "y / n"
                  : "Message CCS Code  (@file · /command · ? for help)"
              }
            />
          )}
        </Box>
      </Box>

      {/* Bottom divider */}
      <Box paddingX={1}>
        <Divider width={dividerWidth} />
      </Box>

      {/* Footer: help grid or compact status bar */}
      {helpOpen ? (
        <HelpMenu terminalWidth={terminalWidth} />
      ) : (
        <StatusBar
          workspacePath={process.cwd()}
          sandboxStatus={permissionMode}
          activeModel={activeModel}
          instructionsCount={instructions.length}
          skillsCount={skills.length}
          terminalWidth={terminalWidth}
        />
      )}
    </Box>
  );
}
