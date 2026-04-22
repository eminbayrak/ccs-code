import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { createPermissionContext } from "../src/governance/permissions.js";
import { executeTool } from "../src/execution/toolExecutor.js";
import {
    getGlobalHookEngine,
    resetGlobalHookEngine,
} from "../src/hooks/engine.js";
import { runOrchestration } from "../src/orchestrator/runtime.js";
import { listAgentRuns } from "../src/tasks/agentRuns.js";
import type { ToolDescriptor } from "../src/capabilities/types.js";
import type { LLMProvider, Message } from "../src/llm/providers/base.js";

describe("CLI behavior: hooks, tools, agents", () => {
    beforeEach(() => {
        resetGlobalHookEngine();
    });

    it("executes tool with pre/post hooks and applies prompt-hook input mutation", async () => {
        const hookEngine = getGlobalHookEngine();
        const seenContexts: Array<{ role: string; content: string; }> = [];

        hookEngine.setLLMProvider({
            chat: async (messages: Message[]) => {
                const last = messages[messages.length - 1];
                seenContexts.push({ role: last?.role ?? "", content: last?.content ?? "" });

                if ((last?.content ?? "").includes('"event": "pre_tool_use"')) {
                    return JSON.stringify({
                        allow: true,
                        updatedInput: { value: "mutated-by-hook" },
                    });
                }

                return JSON.stringify({ allow: true });
            },
        });

        hookEngine.register({
            id: "pre-mutate",
            event: "pre_tool_use",
            matcher: { toolNames: ["demo_tool"] },
            handler: {
                type: "prompt",
                prompt: "Mutate input if needed",
            },
        });

        hookEngine.register({
            id: "post-observe",
            event: "post_tool_use",
            matcher: { toolNames: ["demo_tool"] },
            handler: {
                type: "prompt",
                prompt: "Observe output",
            },
        });

        const tool: ToolDescriptor = {
            id: "demo.tool",
            name: "demo_tool",
            kind: "tool",
            description: "Demo tool",
            riskClass: "read",
            inputSchema: z.object({ value: z.string() }),
            handler: async (input) => {
                return { status: "success", output: { received: (input as any).value } };
            },
        };

        const result = await executeTool(
            tool,
            { value: "original" },
            {
                cwd: process.cwd(),
                permissionContext: createPermissionContext("default"),
            },
        );

        expect(result.status).toBe("success");
        expect(result.output).toEqual({ received: "mutated-by-hook" });
        expect(seenContexts.length).toBeGreaterThanOrEqual(2);
    });

    it("allows write tool when permission_request hook approves", async () => {
        const hookEngine = getGlobalHookEngine();

        hookEngine.setLLMProvider({
            chat: async () => JSON.stringify({ allow: true, permissionDecision: "approved" }),
        });

        hookEngine.register({
            id: "perm-approver",
            event: "permission_request",
            matcher: { toolNames: ["write_demo"] },
            handler: {
                type: "prompt",
                prompt: "Approve safe internal write operation",
            },
        });

        const writeTool: ToolDescriptor = {
            id: "write.demo",
            name: "write_demo",
            kind: "tool",
            description: "Write demo",
            riskClass: "write",
            handler: async () => ({ status: "success", output: { ok: true } }),
        };

        const result = await executeTool(writeTool, {}, {
            cwd: process.cwd(),
            permissionContext: createPermissionContext("default"),
        });

        expect(result.status).toBe("success");
        expect(result.output).toEqual({ ok: true });
    });

    it("runs orchestration agent step and tracks agent run lifecycle", async () => {
        const provider: LLMProvider = {
            name: "test-provider",
            chat: async (messages) => {
                const last = messages[messages.length - 1]?.content ?? "";
                if (last.includes("Agent task (implementation):")) {
                    return "agent-run-result";
                }
                return "final-assistant-response";
            },
        };

        const output = await runOrchestration(provider, {
            cwd: process.cwd(),
            systemPrompt: "test system prompt",
            history: [{ role: "user", content: "implement a helper function" }],
            capabilities: { tools: [], connectors: [] },
            permissionContext: createPermissionContext("default"),
        });

        expect(output.startedAgentRunIds.length).toBe(1);
        expect(output.response).toBe("final-assistant-response");

        const runId = output.startedAgentRunIds[0];
        const run = listAgentRuns().find((r) => r.id === runId);

        expect(run).toBeDefined();
        expect(run?.status).toBe("completed");
        expect(run?.result).toBe("agent-run-result");
    });
});
