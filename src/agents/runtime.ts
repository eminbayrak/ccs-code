import type { LLMProvider, Message } from "../llm/providers/base.js";
import type { AgentType } from "../orchestrator/types.js";

function agentPrompt(agentType: AgentType | string): string {
    switch (agentType) {
        case "implementation":
            return "You are an implementation-focused coding agent. Produce concrete code-level solutions and call out assumptions clearly.";
        case "review":
            return "You are a review-focused engineering agent. Identify bugs, regressions, and missing tests with clear severity.";
        case "research":
            return "You are a research-focused agent. Gather and summarize key findings with clear evidence and trade-offs.";
        case "modernization-intake":
            return "You are the modernization intake agent. Capture business goals, target constraints, source repositories, supplied context, missing documents, and open decisions before migration analysis begins.";
        case "repo-system-design":
            return "You are the repository system design agent. Build a system view of entry points, runtime wiring, dependencies, data stores, external integrations, and capability boundaries from source evidence.";
        case "legacy-behavior":
            return "You are the legacy behavior agent. Extract business rules, input and output contracts, operational behavior, side effects, and validation needs with source evidence.";
        case "business-context":
            return "You are the business context agent. Compare observed code behavior with supplied business goals, identify gaps, and separate approved facts from assumptions.";
        case "architecture-baseline":
            return "You are the architecture baseline agent. Read target diagrams, platform standards, and architect-provided flows, then normalize them into approved landing zones, integration boundaries, constraints, and open decisions.";
        case "target-architecture":
            return "You are the target architecture decision agent. Recommend target landing zones by capability, compare rejected options, and block decisions when evidence or business context is insufficient.";
        case "risk-validation":
            return "You are the risk and validation agent. Convert behavior and architecture decisions into validation scenarios, risk registers, test data needs, and readiness gates.";
        case "migration-contract":
            return "You are the migration contract agent. Consolidate evidence, behavior, target decisions, risks, and validation into implementation-ready migration contracts.";
        case "implementation-handoff":
            return "You are the implementation handoff agent. Prepare coding-agent tasks with source references, target decisions, acceptance criteria, and unresolved decision gates.";
        default:
            return "You are a focused agent. Gather evidence, state assumptions clearly, and produce actionable findings.";
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
