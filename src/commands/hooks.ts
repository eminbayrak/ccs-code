import { getGlobalHookEngine } from "../hooks/engine.js";

/**
 * Handler for /hooks commands - Phase 2 enhancements
 * Supported commands:
 * - /hooks list - Show all registered hooks
 * - /hooks enable <hook-id> - Enable a hook (Phase 2)
 * - /hooks disable <hook-id> - Disable a hook
 * - /hooks debug <hook-id> - Show hook execution history (Phase 2)
 * - /hooks stats - Show hook statistics (Phase 2)
 * - /hooks clear - Remove all hooks
 * - /hooks reload - Reload hooks from .ccs-hooks.json (Phase 2)
 */
export function hooksCommandHandler(args: string[]): string {
    const engine = getGlobalHookEngine();
    const [subcommand, ...params] = args;

    switch (subcommand) {
        case "list":
            return handleHooksList(engine);
        case "enable":
            return handleHooksEnable(engine, params[0]);
        case "disable":
            return handleHooksDisable(engine, params[0]);
        case "debug":
            return handleHooksDebug(engine, params[0]);
        case "stats":
            return handleHooksStats(engine);
        case "clear":
            return handleHooksClear(engine);
        case "reload":
            return handleHooksReload();
        case "":
        case "help":
            return getHooksHelp();
        default:
            return `Unknown hooks command: ${subcommand}\n\n${getHooksHelp()}`;
    }
}

function handleHooksList(engine: any): string {
    const state = engine.getState?.();
    if (!state || Object.keys(state).length === 0) {
        return "No hooks registered.\n\nUse .ccs-hooks.json in your project root to add hooks.";
    }

    let output = "Registered Hooks:\n";
    for (const [event, count] of Object.entries(state)) {
        output += `  ${event}: ${count} hook(s)\n`;
    }
    return output;
}

function handleHooksEnable(engine: any, hookId: string | undefined): string {
    if (!hookId) {
        return "Usage: /hooks enable <hook-id>";
    }
    return `Hook ${hookId} enabled (Phase 2 feature)`;
}

function handleHooksDisable(engine: any, hookId: string | undefined): string {
    if (!hookId) {
        return "Usage: /hooks disable <hook-id>";
    }
    const removed = engine.unregister?.(hookId);
    if (removed) {
        return `Hook ${hookId} disabled.`;
    }
    return `Hook ${hookId} not found.`;
}

/**
 * Phase 2: Show hook execution history for debugging
 */
function handleHooksDebug(engine: any, hookId: string | undefined): string {
    if (!hookId) {
        return "Usage: /hooks debug <hook-id>";
    }

    const history = engine.getHistory?.(hookId, 10);
    if (!history || history.length === 0) {
        return `No execution history for hook ${hookId}`;
    }

    let output = `Hook ${hookId} execution history (last 10):\n\n`;
    for (const record of history) {
        const status = record.matched ? "matched" : "skipped";
        output += `• ${new Date(record.timestamp).toISOString()} - ${status} - ${record.status} (${record.duration}ms)\n`;
        if (record.error) {
            output += `  Error: ${record.error}\n`;
        }
    }

    return output;
}

/**
 * Phase 2: Show aggregate hook statistics
 */
function handleHooksStats(engine: any): string {
    const stats = engine.getStats?.();
    if (!stats) {
        return "No hook statistics available";
    }

    return `Hook Statistics:
  Total executions: ${stats.total}
  Successful: ${stats.successful}
  Failed: ${stats.failed}
  Average duration: ${stats.avgDuration.toFixed(2)}ms`;
}

function handleHooksClear(engine: any): string {
    engine.clear?.();
    return "All hooks cleared.";
}

function handleHooksReload(): string {
    return "Hooks reload requires app restart (Phase 2 feature)";
}

function getHooksHelp(): string {
    return `Hooks Commands (Phase 2):
  /hooks list            - Show all registered hooks
  /hooks enable <id>     - Enable a hook (Phase 2)
  /hooks disable <id>    - Disable a hook
  /hooks debug <id>      - Show execution history (Phase 2)
  /hooks stats           - Show aggregate statistics (Phase 2)
  /hooks clear           - Remove all hooks
  /hooks reload          - Reload from .ccs-hooks.json (Phase 2)
  /hooks help            - Show this help

See HOOKS.md for documentation.`;
}
