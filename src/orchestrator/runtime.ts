import type { LLMProvider, Message } from "../llm/providers/base.js";
import { executeTool } from "../execution/toolExecutor.js";
import type { ExecutionPlan, OrchestratorOutput, RuntimeContext } from "./types.js";
import { planGoal } from "./planner.js";
import { RunLogger } from "../telemetry/runLog.js";
import { buildRoutingGuidance } from "../prompts/routing.js";
import { runAgentTask } from "../agents/runtime.js";
import {
    completeAgentRun,
    createAgentRun,
    failAgentRun,
} from "../tasks/agentRuns.js";
import { getGlobalHookEngine } from "../hooks/engine.js";
import type { HookContext } from "../hooks/types.js";

function getLastUserMessage(history: Message[]): string {
    const message = [...history].reverse().find((m) => m.role === "user");
    return message?.content ?? "";
}

function summarizeToolOutput(toolName: string, result: unknown): string {
    return `Tool ${toolName} output:\n${JSON.stringify(result, null, 2).slice(0, 4000)}`;
}

export async function runOrchestration(
    provider: LLMProvider,
    runtime: RuntimeContext,
): Promise<OrchestratorOutput> {
    const hookEngine = getGlobalHookEngine();
    const sessionId = hookEngine.getSessionId();
    const logger = new RunLogger();
    const usedTools: string[] = [];
    const startedAgentRunIds: string[] = [];

    // Emit session_start hook
    const sessionStartCtx: HookContext = {
        event: "session_start",
        timestamp: Date.now(),
        sessionId,
        cwd: runtime.cwd,
    };
    await hookEngine.emit(sessionStartCtx);

    try {
        const userGoal = getLastUserMessage(runtime.history);
        const plan: ExecutionPlan = planGoal(userGoal, runtime.capabilities);
        logger.add({ type: "plan", payload: plan });

        let workingHistory = [...runtime.history];

        for (const step of plan.steps) {
            if (step.type === "direct_answer") {
                const response = await provider.chat(
                    workingHistory,
                    [runtime.systemPrompt, buildRoutingGuidance(runtime.capabilities)].filter(Boolean).join("\n\n"),
                );
                logger.add({ type: "response", payload: { response } });

                // Emit session_end hook on success
                const sessionEndCtx: HookContext = {
                    event: "session_end",
                    timestamp: Date.now(),
                    sessionId,
                    cwd: runtime.cwd,
                };
                await hookEngine.emit(sessionEndCtx);

                return { response, usedTools, startedAgentRunIds, logs: logger.getEvents() };
            }

            if (step.type === "agent_call") {
                const run = createAgentRun(step.agentType, step.prompt);
                startedAgentRunIds.push(run.id);
                logger.add({
                    type: "tool_call",
                    payload: {
                        kind: "agent_call",
                        runId: run.id,
                        agentType: step.agentType,
                        runInBackground: Boolean(step.runInBackground),
                    },
                });

                if (step.runInBackground) {
                    void runAgentTask(
                        provider,
                        step.agentType,
                        step.prompt,
                        workingHistory,
                        runtime.systemPrompt,
                    )
                        .then((result) => {
                            completeAgentRun(run.id, result);
                        })
                        .catch((error) => {
                            failAgentRun(run.id, error instanceof Error ? error.message : String(error));
                        });

                    workingHistory = [
                        ...workingHistory,
                        {
                            role: "assistant",
                            content: `Background ${step.agentType} agent started. Task ID: ${run.id}`,
                        },
                    ];
                    continue;
                }

                try {
                    const result = await runAgentTask(
                        provider,
                        step.agentType,
                        step.prompt,
                        workingHistory,
                        runtime.systemPrompt,
                    );
                    completeAgentRun(run.id, result);
                    workingHistory = [
                        ...workingHistory,
                        {
                            role: "assistant",
                            content: `Agent ${step.agentType} result:\n${result.slice(0, 4000)}`,
                        },
                    ];
                    continue;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    failAgentRun(run.id, message);
                    const response = `Agent ${step.agentType} failed: ${message}`;
                    logger.add({ type: "response", payload: { response } });

                    // Emit session_end hook on error
                    const sessionEndCtx: HookContext = {
                        event: "session_end",
                        timestamp: Date.now(),
                        sessionId,
                        cwd: runtime.cwd,
                    };
                    await hookEngine.emit(sessionEndCtx);

                    return { response, usedTools, startedAgentRunIds, logs: logger.getEvents() };
                }
            }

            const tool = runtime.capabilities.tools.find((t) => t.name === step.toolName);
            if (!tool) {
                logger.add({ type: "error", payload: { message: `Tool ${step.toolName} not found.` } });
                const response = await provider.chat(
                    workingHistory,
                    runtime.systemPrompt,
                );

                // Emit session_end hook on error
                const sessionEndCtx: HookContext = {
                    event: "session_end",
                    timestamp: Date.now(),
                    sessionId,
                    cwd: runtime.cwd,
                };
                await hookEngine.emit(sessionEndCtx);

                return { response, usedTools, startedAgentRunIds, logs: logger.getEvents() };
            }

            usedTools.push(tool.name);
            logger.add({ type: "tool_call", payload: { name: tool.name, input: step.input } });

            const toolResult = await executeTool(tool, step.input, {
                cwd: runtime.cwd,
                permissionContext: runtime.permissionContext,
                sessionId,
            });
            logger.add({ type: "tool_result", payload: toolResult });

            if (toolResult.status === "approval_required") {
                // Emit session_end hook on approval required
                const sessionEndCtx: HookContext = {
                    event: "session_end",
                    timestamp: Date.now(),
                    sessionId,
                    cwd: runtime.cwd,
                };
                await hookEngine.emit(sessionEndCtx);

                return {
                    response: `Approval required for ${tool.name}. Approval ID: ${toolResult.approvalId}`,
                    usedTools,
                    startedAgentRunIds,
                    logs: logger.getEvents(),
                };
            }

            if (toolResult.status === "error") {
                const response = `Tool ${tool.name} failed: ${toolResult.error}`;
                logger.add({ type: "response", payload: { response } });

                // Emit session_end hook on error
                const sessionEndCtx: HookContext = {
                    event: "session_end",
                    timestamp: Date.now(),
                    sessionId,
                    cwd: runtime.cwd,
                };
                await hookEngine.emit(sessionEndCtx);

                return { response, usedTools, startedAgentRunIds, logs: logger.getEvents() };
            }

            workingHistory = [
                ...workingHistory,
                {
                    role: "assistant",
                    content: summarizeToolOutput(tool.name, toolResult.output),
                },
            ];
        }

        const response = await provider.chat(
            workingHistory,
            [runtime.systemPrompt, buildRoutingGuidance(runtime.capabilities)].filter(Boolean).join("\n\n"),
        );
        logger.add({ type: "response", payload: { response } });

        // Emit session_end hook on success
        const sessionEndCtx: HookContext = {
            event: "session_end",
            timestamp: Date.now(),
            sessionId,
            cwd: runtime.cwd,
        };
        await hookEngine.emit(sessionEndCtx);

        return {
            response,
            usedTools,
            startedAgentRunIds,
            logs: logger.getEvents(),
        };
    } catch (error) {
        // Emit session_end hook on error
        const sessionEndCtx: HookContext = {
            event: "session_end",
            timestamp: Date.now(),
            sessionId,
            cwd: runtime.cwd,
        };
        await hookEngine.emit(sessionEndCtx);

        throw error;
    }
}
