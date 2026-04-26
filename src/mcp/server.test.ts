import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeMessage, handleRequest, splitFrame, type JsonRpcRequest } from "./server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRewriteFixture(): Promise<{ root: string; rewriteDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ccs-mcp-server-"));
  tempDirs.push(root);
  const rewriteDir = join(root, "migration", "rewrite");
  await mkdir(join(rewriteDir, "context"), { recursive: true });

  await writeFile(join(rewriteDir, "migration-contract.json"), JSON.stringify({
    schemaVersion: "1.0",
    repoUrl: "https://github.com/acme/legacy",
    migration: {
      sourceFramework: "vb6",
      targetFramework: "azure-functions",
      targetLanguage: "typescript",
    },
    globalGuardrails: ["Preserve business behaviour."],
    migrationOrder: ["FileRouter"],
    components: [
      {
        name: "FileRouter",
        type: "service",
        implementationStatus: "ready",
        sourceFiles: ["src/FileRouter.bas"],
        dependencies: [],
        target: { role: "azure_function", rationale: "Event-driven.", targetFileHint: "file_router.ts" },
        risk: { confidence: "high", complexity: "medium", migrationRisks: [] },
        businessRules: [{ statement: "Reject unsupported files." }],
        contracts: { input: { fileName: "string" }, output: { taskId: "string" } },
        humanQuestions: [],
        validationScenarios: ["Reject unsupported files."],
        acceptanceCriteria: [],
      },
      {
        name: "AddressCorrector",
        type: "service",
        implementationStatus: "blocked",
        sourceFiles: ["src/AddressCorrector.bas"],
        dependencies: ["FileRouter"],
        humanQuestions: ["Which address provider should we use?"],
      },
    ],
  }), "utf-8");

  return { root, rewriteDir };
}

// ---------------------------------------------------------------------------
// encodeMessage — NDJSON frame encoder
// ---------------------------------------------------------------------------

describe("encodeMessage", () => {
  test("emits one JSON object terminated by a single \\n", () => {
    const out = encodeMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(out.endsWith("\n")).toBe(true);
    expect(out.indexOf("\n")).toBe(out.length - 1);
    expect(JSON.parse(out)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  test("does not embed literal newlines inside the frame even when payload contains \\n", () => {
    const out = encodeMessage({ text: "line1\nline2" });
    // Only one newline, at the very end.
    const interior = out.slice(0, -1);
    expect(interior.includes("\n")).toBe(false);
    // Payload still round-trips.
    expect(JSON.parse(out).text).toBe("line1\nline2");
  });

  test("does not emit LSP-style Content-Length headers", () => {
    const out = encodeMessage({ jsonrpc: "2.0", id: 1, result: {} });
    expect(out.toLowerCase().includes("content-length")).toBe(false);
    expect(out.includes("\r\n\r\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// splitFrame — NDJSON reader
// ---------------------------------------------------------------------------

function drainFrames(buf: Buffer): { frames: string[]; leftover: string } {
  const frames: string[] = [];
  let cur: Buffer = buf;
  while (true) {
    const f = splitFrame(cur);
    if (!f) break;
    frames.push(f.body.toString("utf-8"));
    cur = f.rest as Buffer;
  }
  return { frames, leftover: cur.toString("utf-8") };
}

describe("splitFrame", () => {
  test("splits LF-terminated frames cleanly", () => {
    const result = drainFrames(Buffer.from('{"a":1}\n{"b":2}\n'));
    expect(result.frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.leftover).toBe("");
  });

  test("strips trailing CR for CRLF-terminated frames", () => {
    const result = drainFrames(Buffer.from('{"a":1}\r\n{"b":2}\r\n'));
    expect(result.frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.leftover).toBe("");
  });

  test("preserves the partial trailing frame as leftover", () => {
    const result = drainFrames(Buffer.from('{"a":1}\n{"b":2'));
    expect(result.frames).toEqual(['{"a":1}']);
    expect(result.leftover).toBe('{"b":2');
  });

  test("skips blank and whitespace-only lines between frames", () => {
    const result = drainFrames(Buffer.from('\n\r\n   \n{"a":1}\n'));
    expect(result.frames).toEqual(['{"a":1}']);
    expect(result.leftover).toBe("");
  });

  test("returns null when no newline is present yet", () => {
    expect(splitFrame(Buffer.from('{"a":1}'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleRequest — JSON-RPC method dispatch
// ---------------------------------------------------------------------------

describe("handleRequest", () => {
  test("initialize returns server info and capabilities", async () => {
    const result = await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    } as JsonRpcRequest) as {
      protocolVersion: string;
      capabilities: { tools: object; prompts: object; resources: object };
      serverInfo: { name: string };
    };

    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo.name).toBe("ccs-code");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.prompts).toBeDefined();
    expect(result.capabilities.resources).toBeDefined();
  });

  test("tools/list advertises the migration tool surface", async () => {
    const result = await handleRequest({
      jsonrpc: "2.0", id: 2, method: "tools/list",
    } as JsonRpcRequest) as { tools: Array<{ name: string }> };

    const names = result.tools.map((t) => t.name);
    expect(names).toContain("ccs_list_ready_components");
    expect(names).toContain("ccs_get_component_context");
    expect(names).toContain("ccs_get_human_questions");
    expect(names).toContain("ccs_get_validation_contract");
    expect(names).toContain("ccs_get_architecture_baseline");
    expect(names).toContain("ccs_get_preflight_readiness");
    expect(names).toContain("ccs_get_system_graph");
    expect(names).toContain("ccs_get_business_logic");
    expect(names).toContain("ccs_get_dependency_impact");
    expect(names).toContain("ccs_get_verification_report");
  });

  test("prompts/list exposes migrate_ready_component and review_human_questions", async () => {
    const result = await handleRequest({
      jsonrpc: "2.0", id: 3, method: "prompts/list",
    } as JsonRpcRequest) as { prompts: Array<{ name: string }> };

    const names = result.prompts.map((p) => p.name);
    expect(names).toContain("migrate_ready_component");
    expect(names).toContain("review_human_questions");
  });

  test("tools/call returns ready components from a migration fixture", async () => {
    const { rewriteDir } = await makeRewriteFixture();

    const result = await handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "ccs_list_ready_components",
        arguments: { migrationDir: rewriteDir },
      },
    } as JsonRpcRequest) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ready).toHaveLength(1);
    expect(payload.ready[0].name).toBe("FileRouter");
    expect(payload.blockedCount).toBe(1);
  });

  test("tools/call surfaces a structured error for an unknown tool", async () => {
    const result = await handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ccs_does_not_exist", arguments: {} },
    } as JsonRpcRequest) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown CCS MCP tool");
  });

  test("tools/call returns an error result when a required argument is missing", async () => {
    const result = await handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "ccs_get_component_context", arguments: {} },
    } as JsonRpcRequest) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("componentname");
  });

  test("prompts/get builds a migrate_ready_component prompt referencing CCS tools", async () => {
    const result = await handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "prompts/get",
      params: { name: "migrate_ready_component", arguments: { componentName: "FileRouter" } },
    } as JsonRpcRequest) as { messages: Array<{ content: { text: string } }> };

    const text = result.messages[0]!.content.text;
    expect(text).toContain("FileRouter");
    expect(text).toContain("ccs_get_preflight_readiness");
    expect(text).toContain("ccs_get_validation_contract");
  });

  test("unknown method surfaces JSON-RPC method-not-found", async () => {
    let caught: unknown;
    try {
      await handleRequest({
        jsonrpc: "2.0", id: 8, method: "does/not/exist",
      } as JsonRpcRequest);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: number }).code).toBe(-32601);
  });

  test("notifications return undefined and have no response", async () => {
    expect(await handleRequest({
      jsonrpc: "2.0", method: "notifications/initialized",
    } as JsonRpcRequest)).toBeUndefined();
    expect(await handleRequest({
      jsonrpc: "2.0", method: "notifications/cancelled",
    } as JsonRpcRequest)).toBeUndefined();
  });
});
