import {
  getArchitectureBaseline,
  getBusinessLogic,
  getComponentContext,
  getDependencyImpact,
  getHumanQuestions,
  getPreflightReadiness,
  getSystemGraph,
  getValidationContract,
  getVerificationReport,
  listReadyComponents,
} from "./artifactReader.js";

type JsonRpcId = string | number | null;
type NodeBuffer = Buffer<ArrayBufferLike>;

export type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type ToolCallParams = {
  name?: string;
  arguments?: Record<string, unknown>;
};

type PromptGetParams = {
  name?: string;
  arguments?: Record<string, unknown>;
};

const tools = [
  {
    name: "ccs_list_ready_components",
    description: "List migration components that passed CCS implementation gates and are ready for Codex or Claude Code.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_ready_work",
    description: "Compatibility alias for ccs_list_ready_components.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_component_context",
    description: "Read the CCS migration context document for one component.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
        componentName: { type: "string", description: "Component name, for example FileRouter." },
      },
      required: ["componentName"],
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_human_questions",
    description: "Read unresolved human decisions from the CCS migration artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_validation_contract",
    description: "Read gates, acceptance criteria, validation scenarios, and risks for one migration component.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
        componentName: { type: "string", description: "Component name, for example FileRouter." },
      },
      required: ["componentName"],
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_architecture_baseline",
    description: "Read the architecture baseline or component disposition matrix used to guide modernization decisions.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_preflight_readiness",
    description: "Read the CCS preflight readiness report with missing context and implementation-readiness gates.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_system_graph",
    description: "Read the CCS system graph with components, source files, packages, target roles, and dependency edges.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_business_logic",
    description: "Read reverse-engineered business logic, rules, contracts, risks, and validation scenarios.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_dependency_impact",
    description: "Analyze graph impact for one component: dependencies, dependents, source files, target roles, and retest scope.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
        nodeName: { type: "string", description: "Component or graph node name, for example FileRouter." },
      },
      required: ["nodeName"],
      additionalProperties: false,
    },
  },
  {
    name: "ccs_get_verification_report",
    description: "Read the CCS verification report. With no componentName, returns the cross-component summary; with a componentName, returns the per-claim audit including which load-bearing claims were confirmed against the cited source.",
    inputSchema: {
      type: "object",
      properties: {
        migrationDir: { type: "string", description: "Optional path to migration/rewrite or migration output directory." },
        componentName: { type: "string", description: "Optional component name. Omit to get the summary across all components." },
      },
      additionalProperties: false,
    },
  },
];

const prompts = [
  {
    name: "migrate_ready_component",
    description: "Prompt a coding agent to implement one CCS-ready migration component.",
    arguments: [
      { name: "componentName", description: "Component name to implement.", required: true },
      { name: "migrationDir", description: "Optional path to migration/rewrite.", required: false },
    ],
  },
  {
    name: "review_human_questions",
    description: "Prompt an agent to summarize unresolved migration decisions for a human architect.",
    arguments: [
      { name: "migrationDir", description: "Optional path to migration/rewrite.", required: false },
    ],
  },
];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function textResult(text: string, isError = false): object {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

async function callTool(params: ToolCallParams): Promise<object> {
  const name = params.name ?? "";
  const args = params.arguments ?? {};
  const migrationDir = asString(args["migrationDir"]);

  switch (name) {
    case "ccs_list_ready_components":
    case "ccs_get_ready_work":
      return textResult(await listReadyComponents(migrationDir));
    case "ccs_get_component_context": {
      const componentName = asString(args["componentName"]);
      if (!componentName) throw new Error("componentName is required.");
      return textResult(await getComponentContext(migrationDir, componentName));
    }
    case "ccs_get_human_questions":
      return textResult(await getHumanQuestions(migrationDir));
    case "ccs_get_validation_contract": {
      const componentName = asString(args["componentName"]);
      if (!componentName) throw new Error("componentName is required.");
      return textResult(await getValidationContract(migrationDir, componentName));
    }
    case "ccs_get_architecture_baseline":
      return textResult(await getArchitectureBaseline(migrationDir));
    case "ccs_get_preflight_readiness":
      return textResult(await getPreflightReadiness(migrationDir));
    case "ccs_get_system_graph":
      return textResult(await getSystemGraph(migrationDir));
    case "ccs_get_business_logic":
      return textResult(await getBusinessLogic(migrationDir));
    case "ccs_get_dependency_impact": {
      const nodeName = asString(args["nodeName"]);
      if (!nodeName) throw new Error("nodeName is required.");
      return textResult(await getDependencyImpact(migrationDir, nodeName));
    }
    case "ccs_get_verification_report": {
      const componentName = asString(args["componentName"]);
      return textResult(await getVerificationReport(migrationDir, componentName));
    }
    default:
      throw new Error(`Unknown CCS MCP tool: ${name}`);
  }
}

function promptMessages(params: PromptGetParams): object {
  const args = params.arguments ?? {};
  const componentName = asString(args["componentName"]) ?? "<componentName>";
  const migrationDir = asString(args["migrationDir"]);
  const migrationHint = migrationDir ? ` Use migrationDir: ${migrationDir}.` : "";

  switch (params.name) {
    case "migrate_ready_component":
      return {
        description: "Implement one CCS-ready migration component.",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: [
              `Use CCS MCP tools to inspect ${componentName}.${migrationHint}`,
              "First call ccs_get_preflight_readiness, ccs_get_architecture_baseline, ccs_get_business_logic, ccs_get_dependency_impact, ccs_get_validation_contract, ccs_get_verification_report (for this component), and ccs_get_component_context.",
              "Only implement if implementationStatus is `ready`, the verification trustVerdict is `ready`, and humanQuestions is empty.",
              "If implementationStatus is `needs_review`, stop and report the verification reasons instead of writing code.",
              "Preserve observed business rules and validate against acceptanceCriteria.",
            ].join("\n"),
          },
        }],
      };
    case "review_human_questions":
      return {
        description: "Summarize unresolved migration decisions.",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Use ccs_get_preflight_readiness, ccs_get_human_questions, and ccs_get_architecture_baseline to summarize unresolved migration decisions.${migrationHint}`,
          },
        }],
      };
    default:
      throw new Error(`Unknown CCS MCP prompt: ${params.name ?? ""}`);
  }
}

export async function handleRequest(request: JsonRpcRequest): Promise<object | undefined> {
  switch (request.method) {
    case "initialize": {
      const params = (request.params ?? {}) as { protocolVersion?: string };
      return {
        protocolVersion: params.protocolVersion ?? "2024-11-05",
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
        serverInfo: {
          name: "ccs-code",
          version: "0.1.0",
        },
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call":
      try {
        return await callTool((request.params ?? {}) as ToolCallParams);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    case "prompts/list":
      return { prompts };
    case "prompts/get":
      return promptMessages((request.params ?? {}) as PromptGetParams);
    case "resources/list":
      return { resources: [] };
    default:
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  }
}

/**
 * Encode a JSON-RPC message in MCP stdio framing: a single line of JSON
 * terminated by `\n`. Exposed for tests so framing semantics stay locked in.
 */
export function encodeMessage(message: object): string {
  // JSON.stringify never produces literal newlines (newlines inside string
  // values are emitted as the escape sequence `\n`), so a single `\n` suffix
  // is an unambiguous frame terminator for any value.
  return `${JSON.stringify(message)}\n`;
}

function writeMessage(message: object): void {
  process.stdout.write(encodeMessage(message));
}

function writeResult(id: JsonRpcId, result: object): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id: JsonRpcId, error: unknown): void {
  const code = typeof error === "object" && error && "code" in error
    ? Number((error as { code: unknown }).code)
    : -32603;
  const message = error instanceof Error ? error.message : String(error);
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Pull the next NDJSON frame out of a buffered stdin chunk. Returns the frame
 * body (no trailing newline, CR stripped) and the remainder of the buffer, or
 * `null` when no complete frame is available yet. Exported for tests.
 */
export function splitFrame(buffer: NodeBuffer): { body: NodeBuffer; rest: NodeBuffer } | null {
  // NDJSON: each frame ends at the next `\n`. Empty/whitespace-only lines are
  // skipped so we tolerate `\r\n` line endings and accidental blank lines.
  while (buffer.length > 0) {
    const newlineIndex = buffer.indexOf(0x0a); // '\n'
    if (newlineIndex === -1) return null;

    const line = buffer.subarray(0, newlineIndex);
    const rest = buffer.subarray(newlineIndex + 1);

    // Trim trailing `\r` and check whether the line carries any payload.
    const trimmedEnd = line.length > 0 && line[line.length - 1] === 0x0d
      ? line.subarray(0, line.length - 1)
      : line;

    if (trimmedEnd.length === 0 || trimmedEnd.toString("utf-8").trim() === "") {
      buffer = rest;
      continue;
    }

    return { body: trimmedEnd, rest };
  }

  return null;
}

export async function startMcpServer(): Promise<void> {
  let buffer: NodeBuffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk: NodeBuffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const frame = splitFrame(buffer);
      if (!frame) return;
      buffer = frame.rest;

      void (async () => {
        let request: JsonRpcRequest;
        try {
          request = JSON.parse(frame.body.toString("utf-8")) as JsonRpcRequest;
        } catch (error) {
          writeError(null, error);
          return;
        }

        const hasId = Object.prototype.hasOwnProperty.call(request, "id");
        try {
          const result = await handleRequest(request);
          if (hasId && result !== undefined) writeResult(request.id ?? null, result);
        } catch (error) {
          if (hasId) writeError(request.id ?? null, error);
        }
      })();
    }
  });

  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.on("end", resolve));
}
