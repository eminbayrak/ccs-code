import { randomUUID } from "crypto";
import type { RiskClass } from "../capabilities/types.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ApprovalRequest = {
    id: string;
    toolName: string;
    rationale: string;
    riskClass: RiskClass;
    status: ApprovalStatus;
    createdAt: number;
};

const approvalQueue = new Map<string, ApprovalRequest>();

export function requestApproval(toolName: string, rationale: string, riskClass: RiskClass): ApprovalRequest {
    const request: ApprovalRequest = {
        id: randomUUID(),
        toolName,
        rationale,
        riskClass,
        status: "pending",
        createdAt: Date.now(),
    };

    approvalQueue.set(request.id, request);
    return request;
}

export function resolveApproval(approvalId: string, decision: "approved" | "rejected"): ApprovalRequest | null {
    const existing = approvalQueue.get(approvalId);
    if (!existing) return null;

    const updated: ApprovalRequest = {
        ...existing,
        status: decision,
    };

    approvalQueue.set(approvalId, updated);
    return updated;
}

export function getPendingApprovals(): ApprovalRequest[] {
    return Array.from(approvalQueue.values()).filter((r) => r.status === "pending");
}

export function getApprovalById(approvalId: string): ApprovalRequest | null {
    return approvalQueue.get(approvalId) ?? null;
}
