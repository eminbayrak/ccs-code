import type { RiskClass } from "../capabilities/types.js";

export type PermissionMode = "default" | "plan" | "permissive";

export type PermissionContext = {
    mode: PermissionMode;
    alwaysAllow: Set<string>;
    alwaysDeny: Set<string>;
};

export function createPermissionContext(mode: PermissionMode = "default"): PermissionContext {
    return {
        mode,
        alwaysAllow: new Set<string>(),
        alwaysDeny: new Set<string>(),
    };
}

export function canExecuteRisk(permissionContext: PermissionContext, riskClass: RiskClass): boolean {
    if (permissionContext.mode === "permissive") {
        return true;
    }

    if (riskClass === "read") {
        return true;
    }

    if (permissionContext.mode === "plan") {
        return false;
    }

    return false;
}
