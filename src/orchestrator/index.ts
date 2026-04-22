import type { LLMProvider, Message } from "../llm/providers/base.js";
import type { OrchestratorOutput } from "./types.js";
import { runOrchestration } from "./runtime.js";
import { loadCapabilities } from "../capabilities/registry.js";
import { createPermissionContext, type PermissionMode } from "../governance/permissions.js";

export type OrchestratorRunInput = {
    cwd: string;
    history: Message[];
    systemPrompt: string;
    permissionMode?: PermissionMode;
};

export class Orchestrator {
    constructor(private readonly provider: LLMProvider) { }

    async run(input: OrchestratorRunInput): Promise<OrchestratorOutput> {
        const capabilities = await loadCapabilities(input.cwd);
        const permissionContext = createPermissionContext(input.permissionMode ?? "default");

        return runOrchestration(this.provider, {
            cwd: input.cwd,
            history: input.history,
            systemPrompt: input.systemPrompt,
            capabilities,
            permissionContext,
        });
    }
}
