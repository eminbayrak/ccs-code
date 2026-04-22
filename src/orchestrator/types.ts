import type { Message } from "../llm/providers/base.js";
import type { CapabilitySnapshot } from "../capabilities/types.js";
import type { PermissionContext } from "../governance/permissions.js";
import type { RunLogEvent } from "../telemetry/runLog.js";

export type PlanStepType = "direct_answer" | "tool_call" | "agent_call";

export type PlanStep =
    | {
        type: "direct_answer";
        reason: string;
    }
    | {
        type: "tool_call";
        reason: string;
        toolName: string;
        input: Record<string, unknown>;
    }
    | {
        type: "agent_call";
        reason: string;
        agentType: "research" | "implementation" | "review";
        prompt: string;
        runInBackground?: boolean;
    };

export type ExecutionPlan = {
    goal: string;
    steps: PlanStep[];
};

export type RuntimeContext = {
    cwd: string;
    systemPrompt: string;
    history: Message[];
    capabilities: CapabilitySnapshot;
    permissionContext: PermissionContext;
};

export type OrchestratorOutput = {
    response: string;
    usedTools: string[];
    startedAgentRunIds: string[];
    logs: RunLogEvent[];
};
