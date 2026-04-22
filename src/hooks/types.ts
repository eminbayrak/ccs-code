/**
 * Hook event system for CCS
 * Allows extensibility through command, prompt, and HTTP webhooks
 * Mirrors Claude Code hooks architecture for compatibility
 */

// Event types that can trigger hooks
export type HookEventType =
    | "session_start"
    | "session_end"
    | "pre_tool_use"
    | "post_tool_use"
    | "post_tool_use_failure"
    | "permission_request";

/** Matcher determines when hook should execute */
export type HookMatcher = {
    /** Limit to specific tool names (undefined = all tools) */
    toolNames?: string[];
    /** Limit to specific risk classes */
    riskClasses?: ("read" | "write" | "dangerous")[];
    /** Phase 2: Custom condition function or expression string */
    condition?: ((context: HookContext) => boolean) | string;
};

/** Context provided to hooks about the current operation */
export type HookContext = {
    event: HookEventType;
    timestamp: number;
    sessionId: string;
    /** Tool-specific context (for pre/post tool use events) */
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: unknown;
    toolError?: string;
    /** Permission context (for permission_request event) */
    permissionId?: string;
    permissionReason?: string;
    riskClass?: string;
    /** User context */
    cwd: string;
};

/** Result returned by a hook */
export type HookResult = {
    /** Whether to allow/proceed */
    allow: boolean;
    /** Optional updated input (for pre_tool_use) */
    updatedInput?: unknown;
    /** Optional message to display */
    message?: string;
    /** Optional decision override (for permission_request) */
    permissionDecision?: "approved" | "rejected";
};

// Hook type definitions

export type CommandHook = {
    type: "command";
    command: string;
    args?: string[];
    /** Timeout in ms */
    timeout?: number;
    /** Continue on error */
    continueOnError?: boolean;
};

export type PromptHook = {
    type: "prompt";
    /** LLM prompt template */
    prompt: string;
    /** System prompt context */
    systemPrompt?: string;
};

export type HttpHook = {
    type: "http";
    url: string;
    method?: "GET" | "POST" | "PUT";
    headers?: Record<string, string>;
    timeout?: number;
};

export type AgentHook = {
    type: "agent";
    agentType: "research" | "implementation" | "review";
    prompt: string;
};

export type HookHandler = CommandHook | PromptHook | HttpHook | AgentHook;

export type Hook = {
    id: string;
    event: HookEventType;
    matcher: HookMatcher;
    handler: HookHandler;
    /** Execute only once */
    once?: boolean;
    /** Async execution without blocking */
    async?: boolean;
    /** Re-trigger if paused (for async hooks) */
    asyncRewake?: boolean;
    /** Priority (higher = runs first) */
    priority?: number;
};

export type HookSource = "project" | "user" | "builtin";

export type HookRegistry = Map<HookEventType, Hook[]>;
