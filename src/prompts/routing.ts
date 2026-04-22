import type { CapabilitySnapshot } from "../capabilities/types.js";

export function buildRoutingGuidance(snapshot: CapabilitySnapshot): string {
    const toolNames = snapshot.tools.map((tool) => tool.name).join(", ");

    return [
        "Routing policy:",
        "1. Prefer dedicated tools over generic shell commands.",
        "2. Prefer local tools for workspace questions.",
        "3. Prefer connector tools for external systems such as GitHub and Jira.",
        "4. Ask for approval before any write or destructive action.",
        `Available tools: ${toolNames || "none"}`,
    ].join("\n");
}
