import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { HookEngine } from "./engine.js";
import { AGENT_TYPES } from "../orchestrator/types.js";
import type { Hook, HookEventType, HookMatcher, HookHandler } from "./types.js";

// Zod schemas for validation

const MatcherSchema = z.object({
    toolNames: z.array(z.string()).optional(),
    riskClasses: z.array(z.enum(["read", "write", "dangerous"])).optional(),
    // condition is stored as string in JSON but converted to function at runtime
});

const CommandHookSchema = z.object({
    type: z.literal("command"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    timeout: z.number().optional(),
    continueOnError: z.boolean().optional(),
});

const PromptHookSchema = z.object({
    type: z.literal("prompt"),
    prompt: z.string(),
    systemPrompt: z.string().optional(),
});

const HttpHookSchema = z.object({
    type: z.literal("http"),
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().optional(),
});

const AgentHookSchema = z.object({
    type: z.literal("agent"),
    agentType: z.enum(AGENT_TYPES),
    prompt: z.string(),
});

const HookHandlerSchema = z.union([
    CommandHookSchema,
    PromptHookSchema,
    HttpHookSchema,
    AgentHookSchema,
]);

const SingleHookSchema = z.object({
    event: z.string(),
    matcher: MatcherSchema.optional(),
    handler: HookHandlerSchema,
    once: z.boolean().optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional(),
    priority: z.number().optional(),
});

const HooksArraySchema = z.array(SingleHookSchema);

const HooksObjectSchema = z.record(z.string(), z.array(SingleHookSchema));

/**
 * Parse hooks from YAML/frontmatter format
 * Format is similar to Claude Code:
 *
 * ```
 * hooks:
 *   - event: pre_tool_use
 *     matcher:
 *       toolNames: [write_file]
 *       riskClasses: [write]
 *     handler:
 *       type: command
 *       command: echo
 *       args: ["Attempting to write file"]
 * ```
 */
export function parseHooksFromFrontmatter(
    content: string,
    engine: HookEngine,
): void {
    try {
        // Extract YAML frontmatter
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!match || !match[1]) {
            return;
        }

        const yaml = match[1];

        // Simple YAML parser for hooks section
        const hooksMatch = yaml.match(/hooks:\r?\n((?:  .*\r?\n)*)/);
        if (!hooksMatch) {
            return;
        }

        // This is a simplified parser - for production, use a proper YAML library
        // For now, just log that hooks were found
        console.debug("Hooks found in frontmatter - full YAML parsing requires library");
    } catch (error) {
        console.error("Error parsing hooks frontmatter:", error);
    }
}

/**
 * Load hooks from JSON configuration
 */
export function loadHooksFromJson(
    hooksConfig: unknown,
    engine: HookEngine,
): void {
    try {
        // Can be array or object keyed by event
        let hooksData: Record<string, unknown>[];

        if (Array.isArray(hooksConfig)) {
            hooksData = hooksConfig as Record<string, unknown>[];
        } else if (typeof hooksConfig === "object" && hooksConfig !== null) {
            // Convert object format to array
            hooksData = [];
            for (const [event, hooks] of Object.entries(hooksConfig)) {
                if (Array.isArray(hooks)) {
                    hooksData.push(
                        ...hooks.map((h: any) => ({
                            ...h,
                            event: h.event || event,
                        })),
                    );
                }
            }
        } else {
            return;
        }

        // Validate with Zod
        const validated = HooksArraySchema.parse(hooksData);

        // Register each hook
        for (const hookData of validated) {
            const hook: Hook = {
                id: `hook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                event: hookData.event as HookEventType,
                matcher: hookData.matcher || {},
                handler: hookData.handler,
                once: hookData.once,
                async: hookData.async,
                asyncRewake: hookData.asyncRewake,
                priority: hookData.priority,
            };

            engine.register(hook);
        }
    } catch (error) {
        console.error("Error loading hooks from JSON:", error);
    }
}

/**
 * Load hooks from a .ccs-hooks.json file in the project
 */
export function loadHooksFromProject(projectRoot: string, engine: HookEngine): void {
    try {
        const hooksPath = join(projectRoot, ".ccs-hooks.json");
        const content = readFileSync(hooksPath, "utf-8");
        const hooksConfig = JSON.parse(content);
        loadHooksFromJson(hooksConfig, engine);
    } catch (error) {
        // File not found or parse error - not critical
        if ((error as any).code !== "ENOENT") {
            console.debug("Note: No .ccs-hooks.json found in project");
        }
    }
}

/**
 * Phase 2: Load user-level hooks from ~/.ccs/hooks/
 * Supports both single .ccs-hooks.json and directory of .json files
 */
export function loadUserHooks(engine: HookEngine): void {
    try {
        const userHooksDir = join(homedir(), ".ccs", "hooks");

        try {
            const files = readdirSync(userHooksDir);
            for (const file of files.filter((f) => f.endsWith(".json"))) {
                try {
                    const content = readFileSync(join(userHooksDir, file), "utf-8");
                    const config = JSON.parse(content);
                    loadHooksFromJson(config, engine);
                    console.debug(`Loaded user hooks from ${file}`);
                } catch (err) {
                    console.warn(`Error loading user hooks from ${file}:`, err);
                }
            }
        } catch (err) {
            if ((err as any).code !== "ENOENT") {
                console.debug(`User hooks directory ${userHooksDir} not found`);
            }
        }
    } catch (error) {
        console.debug("Could not load user hooks", error);
    }
}

/**
 * Export hook schema types for users
 */
export const HookSchemas = {
    Command: CommandHookSchema,
    Prompt: PromptHookSchema,
    Http: HttpHookSchema,
    Agent: AgentHookSchema,
    Handler: HookHandlerSchema,
    SingleHook: SingleHookSchema,
    HooksArray: HooksArraySchema,
    HooksObject: HooksObjectSchema,
};

export type ValidHookConfig = z.infer<typeof HooksArraySchema>;
