import type { LLMProvider, Message } from "../llm/providers/base.js";

function agentPrompt(agentType: string): string {
    switch (agentType) {
        case "implementation":
            return "You are an implementation-focused coding agent. Produce concrete code-level solutions and call out assumptions clearly.";
        case "review":
            return "You are a review-focused engineering agent. Identify bugs, regressions, and missing tests with clear severity.";
        case "research":
        default:
            return "You are a research-focused agent. Gather and summarize key findings with clear evidence and trade-offs.";
    }
}

export async function runAgentTask(
    provider: LLMProvider,
    agentType: string,
    prompt: string,
    history: Message[],
    systemPrompt: string,
): Promise<string> {
    const scopedSystemPrompt = [
        systemPrompt,
        "Agent execution mode is active.",
        agentPrompt(agentType),
    ]
        .filter(Boolean)
        .join("\n\n");

    const scopedHistory: Message[] = [
        ...history,
        {
            role: "user",
            content: `Agent task (${agentType}): ${prompt}`,
        },
    ];

    return provider.chat(scopedHistory, scopedSystemPrompt);
}
