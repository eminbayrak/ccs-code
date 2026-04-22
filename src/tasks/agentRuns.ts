import { randomUUID } from "crypto";

export type AgentRunStatus = "running" | "completed" | "failed";

export type AgentRun = {
    id: string;
    agentType: string;
    prompt: string;
    status: AgentRunStatus;
    startedAt: number;
    finishedAt?: number;
    result?: string;
    error?: string;
};

const runs = new Map<string, AgentRun>();

export function createAgentRun(agentType: string, prompt: string): AgentRun {
    const run: AgentRun = {
        id: randomUUID(),
        agentType,
        prompt,
        status: "running",
        startedAt: Date.now(),
    };
    runs.set(run.id, run);
    return run;
}

export function completeAgentRun(id: string, result: string): AgentRun | null {
    const run = runs.get(id);
    if (!run) return null;
    const updated: AgentRun = {
        ...run,
        status: "completed",
        finishedAt: Date.now(),
        result,
    };
    runs.set(id, updated);
    return updated;
}

export function failAgentRun(id: string, error: string): AgentRun | null {
    const run = runs.get(id);
    if (!run) return null;
    const updated: AgentRun = {
        ...run,
        status: "failed",
        finishedAt: Date.now(),
        error,
    };
    runs.set(id, updated);
    return updated;
}

export function listAgentRuns(): AgentRun[] {
    return Array.from(runs.values()).sort((a, b) => b.startedAt - a.startedAt);
}
