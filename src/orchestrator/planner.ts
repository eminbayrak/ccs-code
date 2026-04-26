import type { ExecutionPlan, PlanStep } from "./types.js";
import type { CapabilitySnapshot } from "../capabilities/types.js";

function buildGitHubSearchQuery(goal: string): string {
    const repoMatch = goal.match(/https?:\/\/(?:www\.)?github(?:\.com|\.enterprise\S*?)\/([\w.-]+)\/([\w.-]+)/i);
    const repoQualifier = repoMatch
        ? ` repo:${repoMatch[1]}/${repoMatch[2]!.replace(/\.git$/i, "").replace(/[.,;)]+$/, "")}`
        : "";

    const cleaned = goal
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/[^\w\s./#-]/g, " ")
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !/^(github|repo|repository|this|that|please|can|you|migrate|rewrite|convert|port|to|into|from|using|with|the|a|an)$/i.test(part))
        .slice(0, 6)
        .join(" ");

    return `${cleaned || "README"}${repoQualifier}`.trim();
}

function extractToolInput(goal: string, toolName: string): Record<string, unknown> {
    if (toolName === "github_search_code") {
        return { query: buildGitHubSearchQuery(goal) };
    }

    if (toolName === "github_list_pull_requests") {
        return {
            owner: process.env.CCS_GITHUB_OWNER ?? "",
            repo: process.env.CCS_GITHUB_REPO ?? "",
            state: "open",
            perPage: 10,
        };
    }

    if (toolName === "jira_get_issue") {
        const issueKeyMatch = goal.match(/[A-Z][A-Z0-9]+-\d+/);
        return {
            baseUrl: process.env.CCS_JIRA_BASE_URL ?? "",
            issueKey: issueKeyMatch?.[0] ?? goal,
        };
    }

    if (toolName === "jira_search_issues") {
        return {
            baseUrl: process.env.CCS_JIRA_BASE_URL ?? "",
            jql: process.env.CCS_JIRA_DEFAULT_JQL ?? "order by updated DESC",
            maxResults: 10,
        };
    }

    if (toolName === "search_files") {
        const query = goal.replace(/find|search|locate/gi, "").trim();
        return { query: query || goal };
    }

    if (toolName === "search_content") {
        return {
            query: goal,
            maxFiles: 20,
        };
    }

    return { query: goal };
}

export function planGoal(goal: string, capabilities: CapabilitySnapshot): ExecutionPlan {
    const lowered = goal.toLowerCase();
    const steps: PlanStep[] = [];
    const isModernizationGoal =
        /(migrate|migration|modernize|modernization|legacy|rewrite|convert|port)/i.test(goal) &&
        /(architecture|service|repo|repository|application|app|system|codebase|language|framework|azure|serverless|function|container|aks|vb6|cobol|mainframe|java|node|\.net|c#)/i.test(goal);

    if (lowered.includes("github")) {
        const listPrTool = capabilities.tools.find((t) => t.name === "github_list_pull_requests");
        const searchCodeTool = capabilities.tools.find((t) => t.name === "github_search_code");
        const selectedTool = lowered.includes("pr") || lowered.includes("pull request")
            ? listPrTool
            : searchCodeTool;

        if (selectedTool) {
            steps.push({
                type: "tool_call",
                reason: "Prompt references GitHub data.",
                toolName: selectedTool.name,
                input: extractToolInput(goal, selectedTool.name),
            });
        }
    }

    if (lowered.includes("jira") || /[A-Z][A-Z0-9]+-\d+/.test(goal)) {
        const searchTool = capabilities.tools.find((t) => t.name === "jira_search_issues");
        const issueTool = capabilities.tools.find((t) => t.name === "jira_get_issue");
        const selectedTool = lowered.includes("search") || lowered.includes("jql")
            ? searchTool
            : issueTool;

        if (selectedTool) {
            steps.push({
                type: "tool_call",
                reason: "Prompt references Jira data.",
                toolName: selectedTool.name,
                input: extractToolInput(goal, selectedTool.name),
            });
        }
    }

    if (/(find|search|locate)/i.test(goal)) {
        const contentSearchTool = capabilities.tools.find((t) => t.name === "search_content");
        const fileSearchTool = capabilities.tools.find((t) => t.name === "search_files");
        const selectedTool = lowered.includes("function") || lowered.includes("class")
            ? contentSearchTool
            : fileSearchTool;

        if (selectedTool) {
            steps.push({
                type: "tool_call",
                reason: "Prompt appears to request repository search.",
                toolName: selectedTool.name,
                input: extractToolInput(goal, selectedTool.name),
            });
        }
    }

    if (isModernizationGoal) {
        steps.push(
            {
                type: "agent_call",
                reason: "Modernization request needs repository system understanding before implementation.",
                agentType: "repo-system-design",
                prompt: goal,
                runInBackground: /background|async/i.test(goal),
            },
            {
                type: "agent_call",
                reason: "Modernization request needs approved target architecture context.",
                agentType: "architecture-baseline",
                prompt: goal,
                runInBackground: /background|async/i.test(goal),
            },
            {
                type: "agent_call",
                reason: "Modernization request needs target architecture decisioning.",
                agentType: "target-architecture",
                prompt: goal,
                runInBackground: /background|async/i.test(goal),
            },
            {
                type: "agent_call",
                reason: "Modernization request needs an implementation-ready migration contract.",
                agentType: "migration-contract",
                prompt: goal,
                runInBackground: /background|async/i.test(goal),
            },
        );
    } else if (/(implement|refactor|fix|build)/i.test(goal)) {
        steps.push({
            type: "agent_call",
            reason: "Prompt suggests implementation work.",
            agentType: "implementation",
            prompt: goal,
            runInBackground: /background|async/i.test(goal),
        });
    } else if (/(review|verify|security|test coverage)/i.test(goal)) {
        steps.push({
            type: "agent_call",
            reason: "Prompt suggests review and verification work.",
            agentType: "review",
            prompt: goal,
            runInBackground: /background|async/i.test(goal),
        });
    } else if (/(research|investigate|analyze|deep)/i.test(goal)) {
        steps.push({
            type: "agent_call",
            reason: "Prompt suggests research-focused work.",
            agentType: "research",
            prompt: goal,
            runInBackground: /background|async/i.test(goal),
        });
    }

    if (steps.length === 0) {
        steps.push({
            type: "direct_answer",
            reason: "No high-confidence tool route; use direct model response.",
        });
    } else {
        steps.push({
            type: "direct_answer",
            reason: "Synthesize the tool and agent findings for user-facing output.",
        });
    }

    return {
        goal,
        steps,
    };
}
