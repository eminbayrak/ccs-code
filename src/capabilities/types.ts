import type { z } from "zod";

export type CapabilityKind = "tool" | "agent" | "connector";
export type RiskClass = "read" | "write" | "destructive";

export type ToolHandlerContext = {
    cwd: string;
};

export type ToolResultStatus = "success" | "error" | "approval_required";

export type ToolResultEnvelope = {
    status: ToolResultStatus;
    output?: unknown;
    error?: string;
    approvalId?: string;
};

export type ToolDescriptor = {
    id: string;
    name: string;
    description: string;
    kind: "tool";
    riskClass: RiskClass;
    inputSchema?: z.ZodType<unknown>;
    handler: (input: unknown, context: ToolHandlerContext) => Promise<ToolResultEnvelope>;
};

export type ConnectorDescriptor = {
    id: string;
    name: string;
    kind: "connector";
    tools: ToolDescriptor[];
};

export type CapabilityDescriptor = ToolDescriptor | ConnectorDescriptor;

export type CapabilitySnapshot = {
    tools: ToolDescriptor[];
    connectors: ConnectorDescriptor[];
};
