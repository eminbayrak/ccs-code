import type { ToolDescriptor, ToolResultEnvelope } from "../capabilities/types.js";
import type { PermissionContext } from "../governance/permissions.js";
import { canExecuteRisk } from "../governance/permissions.js";
import { requestApproval } from "../governance/approvals.js";
import { getGlobalHookEngine } from "../hooks/engine.js";
import type { HookContext } from "../hooks/types.js";

export type ToolExecutionContext = {
    cwd: string;
    permissionContext: PermissionContext;
    sessionId?: string;
};

export async function executeTool(
    tool: ToolDescriptor,
    input: unknown,
    context: ToolExecutionContext,
): Promise<ToolResultEnvelope> {
    const hookEngine = getGlobalHookEngine();
    const sessionId = context.sessionId || hookEngine.getSessionId();

    // Emit pre_tool_use hook
    const preHookCtx: HookContext = {
        event: "pre_tool_use",
        timestamp: Date.now(),
        sessionId,
        toolName: tool.name,
        toolInput: input,
        cwd: context.cwd,
        riskClass: tool.riskClass,
    };

    const preResults = await hookEngine.emit(preHookCtx);
    let processedInput = input;

    // Check if any pre-hook rejected
    if (preResults.some((r) => !r.allow)) {
        return {
            status: "error",
            error: "Tool execution blocked by pre_tool_use hook",
        };
    }

    // Apply input mutations from pre-hooks
    for (const result of preResults) {
        if (result.updatedInput !== undefined) {
            processedInput = result.updatedInput;
        }
    }

    if (!canExecuteRisk(context.permissionContext, tool.riskClass)) {
        // Emit permission_request hook
        const permissionId = `perm_${Date.now()}`;
        const permHookCtx: HookContext = {
            event: "permission_request",
            timestamp: Date.now(),
            sessionId,
            toolName: tool.name,
            toolInput: processedInput,
            cwd: context.cwd,
            riskClass: tool.riskClass,
            permissionId,
            permissionReason: `Tool ${tool.name} requires approval for risk class ${tool.riskClass}.`,
        };

        const permResults = await hookEngine.emit(permHookCtx);

        // Check if any hook approved
        const isApproved = permResults.some((r) => r.permissionDecision === "approved");
        if (isApproved) {
            // Proceed with execution
        } else {
            const approval = requestApproval(
                tool.name,
                `Tool ${tool.name} requires approval for risk class ${tool.riskClass}.`,
                tool.riskClass,
            );

            return {
                status: "approval_required",
                approvalId: approval.id,
                error: approval.rationale,
            };
        }
    }

    // Execute tool
    let toolOutput: unknown;
    let toolError: string | undefined;

    try {
        if (tool.inputSchema) {
            const parsed = tool.inputSchema.safeParse(processedInput);
            if (!parsed.success) {
                return {
                    status: "error",
                    error: parsed.error.message,
                };
            }

            const result = await tool.handler(parsed.data, { cwd: context.cwd });
            if (result.status !== "success") {
                throw new Error(result.error || "Tool execution failed");
            }
            toolOutput = result.output;
        } else {
            const result = await tool.handler(processedInput, { cwd: context.cwd });
            if (result.status !== "success") {
                throw new Error(result.error || "Tool execution failed");
            }
            toolOutput = result.output;
        }

        // Emit post_tool_use hook
        const postHookCtx: HookContext = {
            event: "post_tool_use",
            timestamp: Date.now(),
            sessionId,
            toolName: tool.name,
            toolInput: processedInput,
            toolOutput,
            cwd: context.cwd,
            riskClass: tool.riskClass,
        };

        await hookEngine.emit(postHookCtx);

        return {
            status: "success",
            output: toolOutput,
        };
    } catch (error) {
        toolError = error instanceof Error ? error.message : String(error);

        // Emit post_tool_use_failure hook
        const failHookCtx: HookContext = {
            event: "post_tool_use_failure",
            timestamp: Date.now(),
            sessionId,
            toolName: tool.name,
            toolInput: processedInput,
            toolError,
            cwd: context.cwd,
            riskClass: tool.riskClass,
        };

        await hookEngine.emit(failHookCtx);

        return {
            status: "error",
            error: toolError,
        };
    }
}
