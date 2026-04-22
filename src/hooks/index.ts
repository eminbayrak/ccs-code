/**
 * Public API for CCS Hooks system
 * Export this from the SDK for users to extend CCS
 */

export type {
    HookEventType,
    HookMatcher,
    HookContext,
    HookResult,
    CommandHook,
    PromptHook,
    HttpHook,
    AgentHook,
    HookHandler,
    Hook,
    HookSource,
    HookRegistry,
} from "./types.js";

export { HookEngine, createHookEngine, getGlobalHookEngine, resetGlobalHookEngine } from "./engine.js";

export {
    parseHooksFromFrontmatter,
    loadHooksFromJson,
    loadHooksFromProject,
    HookSchemas,
    type ValidHookConfig,
} from "./loader.js";

/**
 * Example usage in .ccs-hooks.json:
 *
 * {
 *   "hooks": [
 *     {
 *       "event": "pre_tool_use",
 *       "matcher": { "toolNames": ["write_file"] },
 *       "handler": {
 *         "type": "http",
 *         "url": "http://localhost:3000/approval",
 *         "method": "POST"
 *       }
 *     }
 *   ]
 * }
 */
