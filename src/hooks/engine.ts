import { randomUUID } from "crypto";
import type { Hook, HookContext, HookEventType, HookRegistry, HookResult } from "./types.js";
import { ExpressionEvaluator, HookHistoryTracker, type HookExecutionRecord } from "./phase2.js";

/**
 * Central hook registry and event system
 * Phase 2 enhancements: Expression evaluation, history tracking
 */
class HookEngine {
    private registry: HookRegistry = new Map();
    private executedOnceHooks = new Set<string>();
    private sessionId: string;
    private expressionEvaluator: ExpressionEvaluator;
    private historyTracker: HookHistoryTracker;

    // Optional contexts for Phase 2 features
    private llmProvider: any = null;
    private agentRuntime: any = null;

    constructor(sessionId?: string) {
        this.sessionId = sessionId || randomUUID();
        this.expressionEvaluator = new ExpressionEvaluator();
        this.historyTracker = new HookHistoryTracker();
    }

    /**
     * Set optional LLM provider for prompt hooks
     */
    setLLMProvider(provider: any): void {
        this.llmProvider = provider;
    }

    /**
     * Set optional agent runtime for agent hooks
     */
    setAgentRuntime(runtime: any): void {
        this.agentRuntime = runtime;
    }

    /**
     * Get hook execution history
     */
    getHistory(hookId?: string, limit?: number): HookExecutionRecord[] {
        return this.historyTracker.getHistory(hookId, limit);
    }

    /**
     * Get hook statistics
     */
    getStats(): any {
        return this.historyTracker.getStats();
    }

    /**
     * Register a hook
     */
    register(hook: Hook): void {
        const event = hook.event;
        if (!this.registry.has(event)) {
            this.registry.set(event, []);
        }
        const hooks = this.registry.get(event)!;
        hooks.push(hook);
        // Sort by priority (higher first)
        hooks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    }

    /**
     * Unregister a hook by ID
     */
    unregister(hookId: string): boolean {
        for (const [, hooks] of this.registry) {
            const index = hooks.findIndex((h) => h.id === hookId);
            if (index >= 0) {
                hooks.splice(index, 1);
                return true;
            }
        }
        return false;
    }

    /**
     * Get all hooks for an event
     */
    getHooks(event: HookEventType): Hook[] {
        return this.registry.get(event) ?? [];
    }

    /**
     * Emit event and execute matching hooks
     * Returns accumulated results from all matching hooks
     */
    async emit(context: HookContext): Promise<HookResult[]> {
        const event = context.event;
        const hooks = this.getHooks(event);
        const results: HookResult[] = [];

        for (const hook of hooks) {
            const startTime = Date.now();
            let matched = false;
            let status: "success" | "failure" | "timeout" = "success";
            let error: string | undefined;
            let result: HookResult | undefined;

            try {
                // Skip if already executed (once mode)
                if (hook.once && this.executedOnceHooks.has(hook.id)) {
                    continue;
                }

                // Check matcher
                if (!this.matchesContext(hook, context)) {
                    continue;
                }

                matched = true;

                // Execute hook
                result = await this.executeHook(hook, context);
                results.push(result);

                // Mark as executed if once mode
                if (hook.once) {
                    this.executedOnceHooks.add(hook.id);
                }

                // Stop processing if explicit deny
                if (!result.allow) {
                    break;
                }
            } catch (err) {
                status = "failure";
                error = err instanceof Error ? err.message : String(err);
                console.error(`Hook ${hook.id} execution failed:`, error);
                // Continue to next hook on error
            }

            // Record execution history
            const duration = Date.now() - startTime;
            this.historyTracker.record({
                id: `${hook.id}_${Date.now()}`,
                hookId: hook.id,
                event: context.event,
                timestamp: startTime,
                matched,
                duration,
                status,
                result,
                error,
            });
        }

        return results;
    }

    /**
     * Check if hook matches the context
     */
    private matchesContext(hook: Hook, context: HookContext): boolean {
        const { matcher } = hook;

        if (matcher.toolNames && context.toolName) {
            if (!matcher.toolNames.includes(context.toolName)) {
                return false;
            }
        }

        if (matcher.riskClasses && context.riskClass) {
            if (!matcher.riskClasses.includes(context.riskClass as any)) {
                return false;
            }
        }

        // Phase 2: Expression-based conditions
        if (matcher.condition) {
            if (typeof matcher.condition === "function") {
                if (!matcher.condition(context)) {
                    return false;
                }
            } else if (typeof matcher.condition === "string") {
                // Evaluate string expression
                if (!this.expressionEvaluator.evaluate(matcher.condition, context)) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Execute a single hook
     */
    private async executeHook(hook: Hook, context: HookContext): Promise<HookResult> {
        const { handler } = hook;

        switch (handler.type) {
            case "command":
                return this.executeCommandHook(handler, context);
            case "prompt":
                return this.executePromptHook(handler, context);
            case "http":
                return this.executeHttpHook(handler, context);
            case "agent":
                return this.executeAgentHook(handler, context);
            default:
                throw new Error(`Unknown hook type: ${(handler as any).type}`);
        }
    }

    /**
     * Execute command hook (shell command)
     */
    private async executeCommandHook(
        handler: any,
        context: HookContext,
    ): Promise<HookResult> {
        const { spawn } = await import("child_process");
        const { promisify } = await import("util");

        return new Promise((resolve) => {
            const timeout = handler.timeout ?? 5000;
            const args = handler.args ?? [];
            const timer = setTimeout(() => {
                proc?.kill();
                resolve({
                    allow: true,
                    message: `Command hook timeout after ${timeout}ms`,
                });
            }, timeout);

            let output = "";
            const proc = spawn(handler.command, args, { cwd: context.cwd, timeout });

            proc.stdout?.on("data", (data) => {
                output += data.toString();
            });

            proc.on("close", (code) => {
                clearTimeout(timer);
                const success = code === 0 || handler.continueOnError;
                resolve({
                    allow: success,
                    message: output || `Command exited with code ${code}`,
                });
            });

            proc.on("error", (error) => {
                clearTimeout(timer);
                if (handler.continueOnError) {
                    resolve({ allow: true, message: error.message });
                } else {
                    resolve({ allow: false, message: error.message });
                }
            });
        });
    }

    /**
     * Execute prompt hook (LLM-based) - Phase 2
     * Uses the LLM provider to evaluate hook logic
     */
    private async executePromptHook(
        handler: any,
        context: HookContext,
    ): Promise<HookResult> {
        if (!this.llmProvider) {
            console.warn("No LLM provider configured - allowing by default");
            return { allow: true };
        }

        try {
            const timeout = handler.timeout ?? 10000;
            const timer = setTimeout(
                () => {
                    throw new Error("Prompt hook timeout");
                },
                timeout,
            );

            const prompt = handler.prompt || "Evaluate the context and respond with JSON containing {allow: boolean}";
            const systemPrompt =
                handler.systemPrompt ||
                "You are a hook evaluator. Analyze the provided context and respond ONLY with valid JSON.";

            // Call LLM with context
            const response = await this.llmProvider.chat(
                [
                    {
                        role: "user",
                        content: `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}`,
                    },
                ],
                systemPrompt,
            );

            clearTimeout(timer);

            // Parse LLM response
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { allow: true, message: "Prompt hook returned non-JSON response" };
            }

            const hookResponse = JSON.parse(jsonMatch[0]);
            return {
                allow: hookResponse.allow !== false,
                updatedInput: hookResponse.updatedInput,
                message: hookResponse.message,
                permissionDecision: hookResponse.permissionDecision,
            };
        } catch (error) {
            console.error("Prompt hook error:", error);
            return {
                allow: true,
                message: error instanceof Error ? error.message : "Prompt hook failed",
            };
        }
    }

    private async executeHttpHook(
        handler: any,
        context: HookContext,
    ): Promise<HookResult> {
        try {
            const timeout = handler.timeout ?? 5000;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);

            const res = await fetch(handler.url, {
                method: handler.method ?? "POST",
                headers: { "Content-Type": "application/json", ...(handler.headers ?? {}) },
                body: JSON.stringify(context),
                signal: controller.signal,
            });
            clearTimeout(timer);

            if (!res.ok) return { allow: true, message: `HTTP hook returned ${res.status}` };
            const json = await res.json() as any;
            return {
                allow: json.allow !== false,
                updatedInput: json.updatedInput,
                message: json.message,
            };
        } catch (error) {
            return { allow: true, message: error instanceof Error ? error.message : "HTTP hook failed" };
        }
    }

    /**
     * Execute agent hook (agentic) - Phase 2
     * Spawns an agent to handle complex hook logic
     */
    private async executeAgentHook(
        handler: any,
        context: HookContext,
    ): Promise<HookResult> {
        if (!this.agentRuntime) {
            console.warn("No agent runtime configured - allowing by default");
            return { allow: true };
        }

        try {
            const timeout = handler.timeout ?? 30000;
            const timer = setTimeout(
                () => {
                    throw new Error("Agent hook timeout");
                },
                timeout,
            );

            const prompt =
                handler.prompt ||
                `Analyze this hook context and determine if execution should proceed: ${JSON.stringify(context)}`;

            // Run agent task  
            const result = await (this.agentRuntime as any).runAgent?.(
                handler.agentType || "research",
                prompt,
            );

            clearTimeout(timer);

            // Parse agent response
            const hookResponse = typeof result === "string" ? JSON.parse(result) : result;
            return {
                allow: hookResponse.allow !== false,
                updatedInput: hookResponse.updatedInput,
                message: hookResponse.message,
                permissionDecision: hookResponse.permissionDecision,
            };
        } catch (error) {
            console.error("Agent hook error:", error);
            return {
                allow: true,
                message: error instanceof Error ? error.message : "Agent hook failed",
            };
        }
    }

    /** Get session ID */
    getSessionId(): string {
        return this.sessionId;
    }

    /** Clear all hooks */
    clear(): void {
        this.registry.clear();
        this.executedOnceHooks.clear();
    }

    /** Get registry state (for debugging) */
    getState() {
        const state: Record<string, number> = {};
        for (const [event, hooks] of this.registry) {
            state[event] = hooks.length;
        }
        return state;
    }
}

// Global singleton instance
let globalEngine: HookEngine | null = null;

export function createHookEngine(sessionId?: string): HookEngine {
    return new HookEngine(sessionId);
}

export function getGlobalHookEngine(): HookEngine {
    if (!globalEngine) {
        globalEngine = new HookEngine();
    }
    return globalEngine;
}

export function resetGlobalHookEngine(): void {
    globalEngine = null;
}

export { HookEngine };
