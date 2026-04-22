import { z } from "zod";
import type { ConnectorAdapter } from "./base.js";
import type { ToolDescriptor } from "../capabilities/types.js";

const getIssueInputSchema = z.object({
    baseUrl: z.string().url(),
    issueKey: z.string().min(1),
});

const searchIssuesInputSchema = z.object({
    baseUrl: z.string().url(),
    jql: z.string().min(1),
    maxResults: z.number().int().positive().max(100).default(10),
});

export const jiraConnector: ConnectorAdapter = {
    name: "jira",
    getTools() {
        const tools: ToolDescriptor[] = [
            {
                id: "jira.get_issue",
                name: "jira_get_issue",
                kind: "tool",
                description: "Fetch a Jira issue by issue key.",
                riskClass: "read",
                inputSchema: getIssueInputSchema,
                async handler(input) {
                    const parsed = getIssueInputSchema.safeParse(input);
                    if (!parsed.success) {
                        return { status: "error", error: parsed.error.message };
                    }

                    const token = process.env.CCS_JIRA_API_TOKEN;
                    const email = process.env.CCS_JIRA_EMAIL;
                    if (!token || !email) {
                        return {
                            status: "error",
                            error: "Missing CCS_JIRA_API_TOKEN or CCS_JIRA_EMAIL in environment.",
                        };
                    }

                    const { baseUrl, issueKey } = parsed.data;
                    const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}`, {
                        headers: {
                            Accept: "application/json",
                            Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
                        },
                    });

                    if (!response.ok) {
                        const text = await response.text();
                        return {
                            status: "error",
                            error: `Jira issue fetch failed (${response.status}): ${text}`,
                        };
                    }

                    const json = await response.json();
                    return {
                        status: "success",
                        output: json,
                    };
                },
            },
            {
                id: "jira.search_issues",
                name: "jira_search_issues",
                kind: "tool",
                description: "Search Jira issues using JQL.",
                riskClass: "read",
                inputSchema: searchIssuesInputSchema,
                async handler(input) {
                    const parsed = searchIssuesInputSchema.safeParse(input);
                    if (!parsed.success) {
                        return { status: "error", error: parsed.error.message };
                    }

                    const token = process.env.CCS_JIRA_API_TOKEN;
                    const email = process.env.CCS_JIRA_EMAIL;
                    if (!token || !email) {
                        return {
                            status: "error",
                            error: "Missing CCS_JIRA_API_TOKEN or CCS_JIRA_EMAIL in environment.",
                        };
                    }

                    const { baseUrl, jql, maxResults } = parsed.data;
                    const url = new URL(`${baseUrl}/rest/api/3/search/jql`);
                    url.searchParams.set("jql", jql);
                    url.searchParams.set("maxResults", String(maxResults));

                    const response = await fetch(url, {
                        headers: {
                            Accept: "application/json",
                            Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
                        },
                    });

                    if (!response.ok) {
                        const text = await response.text();
                        return {
                            status: "error",
                            error: `Jira search failed (${response.status}): ${text}`,
                        };
                    }

                    const json = await response.json();
                    return {
                        status: "success",
                        output: json,
                    };
                },
            },
        ];

        return tools;
    },
};
