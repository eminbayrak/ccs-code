import { promises as fs } from "fs";
import { dirname, join } from "path";
import { z } from "zod";
import type { CapabilitySnapshot, ConnectorDescriptor, ToolDescriptor } from "./types.js";
import type { ConnectorAdapter } from "../connectors/base.js";
import { githubConnector } from "../connectors/github.js";
import { jiraConnector } from "../connectors/jira.js";

const localReadInputSchema = z.object({ path: z.string().min(1) });
const localSearchInputSchema = z.object({ query: z.string().min(1) });
const localSearchContentInputSchema = z.object({
    query: z.string().min(1),
    maxFiles: z.number().int().positive().max(100).optional(),
});
const localWriteInputSchema = z.object({
    path: z.string().min(1),
    content: z.string(),
});

function getLocalTools(): ToolDescriptor[] {
    return [
        {
            id: "local.read_file",
            name: "read_file",
            kind: "tool",
            description: "Read a local workspace file as text.",
            riskClass: "read",
            inputSchema: localReadInputSchema,
            async handler(input, context) {
                const parsed = localReadInputSchema.safeParse(input);
                if (!parsed.success) {
                    return { status: "error", error: parsed.error.message };
                }

                const fullPath = join(context.cwd, parsed.data.path);
                try {
                    const content = await fs.readFile(fullPath, "utf-8");
                    return {
                        status: "success",
                        output: {
                            path: parsed.data.path,
                            content,
                        },
                    };
                } catch (error) {
                    return {
                        status: "error",
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            },
        },
        {
            id: "local.search_files",
            name: "search_files",
            kind: "tool",
            description: "Search workspace file names by case-insensitive substring.",
            riskClass: "read",
            inputSchema: localSearchInputSchema,
            async handler(input, context) {
                const parsed = localSearchInputSchema.safeParse(input);
                if (!parsed.success) {
                    return { status: "error", error: parsed.error.message };
                }

                const query = parsed.data.query.toLowerCase();
                try {
                    const entries = await fs.readdir(context.cwd, { recursive: true });
                    const matches = entries
                        .map((entry) => String(entry))
                        .filter((entry) => entry.toLowerCase().includes(query))
                        .slice(0, 20);

                    return {
                        status: "success",
                        output: { query: parsed.data.query, matches },
                    };
                } catch (error) {
                    return {
                        status: "error",
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            },
        },
        {
            id: "local.search_content",
            name: "search_content",
            kind: "tool",
            description: "Search file contents in the workspace for matching text.",
            riskClass: "read",
            inputSchema: localSearchContentInputSchema,
            async handler(input, context) {
                const parsed = localSearchContentInputSchema.safeParse(input);
                if (!parsed.success) {
                    return { status: "error", error: parsed.error.message };
                }

                const query = parsed.data.query.toLowerCase();
                const maxFiles = parsed.data.maxFiles ?? 20;

                try {
                    const entries = await fs.readdir(context.cwd, { recursive: true });
                    const filePaths = entries.map((entry) => String(entry));

                    const matches: Array<{ path: string; snippet: string; }> = [];
                    for (const relativePath of filePaths) {
                        const fullPath = join(context.cwd, relativePath);
                        try {
                            const content = await fs.readFile(fullPath, "utf-8");
                            const idx = content.toLowerCase().indexOf(query);
                            if (idx >= 0) {
                                const snippet = content.slice(Math.max(0, idx - 60), idx + 120);
                                matches.push({ path: relativePath, snippet });
                            }
                            if (matches.length >= maxFiles) break;
                        } catch {
                            // Skip unreadable/non-text files.
                        }
                    }

                    return {
                        status: "success",
                        output: { query: parsed.data.query, matches },
                    };
                } catch (error) {
                    return {
                        status: "error",
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            },
        },
        {
            id: "local.write_file",
            name: "write_file",
            kind: "tool",
            description: "Write text content to a local workspace file.",
            riskClass: "write",
            inputSchema: localWriteInputSchema,
            async handler(input, context) {
                const parsed = localWriteInputSchema.safeParse(input);
                if (!parsed.success) {
                    return { status: "error", error: parsed.error.message };
                }

                const fullPath = join(context.cwd, parsed.data.path);
                try {
                    await fs.mkdir(dirname(fullPath), { recursive: true });
                    await fs.writeFile(fullPath, parsed.data.content, "utf-8");
                    return {
                        status: "success",
                        output: { path: parsed.data.path, bytes: Buffer.byteLength(parsed.data.content, "utf-8") },
                    };
                } catch (error) {
                    return {
                        status: "error",
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            },
        },
    ];
}

function loadConnectorAdapters(): ConnectorAdapter[] {
    return [githubConnector, jiraConnector];
}

export async function loadCapabilities(cwd: string): Promise<CapabilitySnapshot> {
    const localTools = getLocalTools();
    const connectorAdapters = loadConnectorAdapters();

    const connectors: ConnectorDescriptor[] = connectorAdapters.map((adapter) => ({
        id: `connector.${adapter.name}`,
        name: adapter.name,
        kind: "connector",
        tools: adapter.getTools({ cwd }),
    }));

    const connectorTools = connectors.flatMap((connector) => connector.tools);

    return {
        tools: [...localTools, ...connectorTools],
        connectors,
    };
}
