import type { MigratePlugin, ServiceReference } from "../../src/migration/types.js";

// Default configuration — matches a common SOAP client pattern.
// Override by calling createPlugin({ callerFunctionName: "myHelper", ... }).
const DEFAULT_CONFIG = {
  callerFunctionName: "constructSoapRequest",
  namespaceField: "serviceNamespace",
  methodField: "methodName",
};

type PluginConfig = typeof DEFAULT_CONFIG;

// ---------------------------------------------------------------------------
// Walk forward in a string to find the matching closing paren
// ---------------------------------------------------------------------------

function findClosingParen(content: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < content.length; i++) {
    if (content[i] === "(") depth++;
    else if (content[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return content.length - 1;
}

// ---------------------------------------------------------------------------
// Extract a named string field from an object literal fragment
// e.g. { serviceNamespace: "FooManager", ... }
// ---------------------------------------------------------------------------

function extractStringField(block: string, field: string): string | null {
  const pattern = new RegExp(
    `['"\\s]?${field}['"]?\\s*:\\s*['"\`]([^'"\`]+)['"\`]`
  );
  return block.match(pattern)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Return 1-based line number of charIndex inside content
// ---------------------------------------------------------------------------

function lineAt(content: string, charIndex: number): number {
  return content.slice(0, charIndex).split("\n").length;
}

// ---------------------------------------------------------------------------
// Plugin factory — lets teams override the function/field names
// ---------------------------------------------------------------------------

export function createPlugin(config: Partial<PluginConfig> = {}): MigratePlugin {
  const cfg: PluginConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    name: "migrate-soap",
    version: "1.0.0",
    description:
      "Scans for SOAP service call patterns and extracts namespace/method references.",

    fileExtensions: [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"],

    scan(filePath: string, content: string): ServiceReference[] {
      const results: ServiceReference[] = [];
      const fnEscaped = cfg.callerFunctionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const callPattern = new RegExp(`${fnEscaped}\\s*\\(`, "g");

      let match: RegExpExecArray | null;
      while ((match = callPattern.exec(content)) !== null) {
        const openParen = match.index + match[0].length - 1;
        const closeParen = findClosingParen(content, openParen);
        const block = content.slice(openParen + 1, closeParen);

        const namespace = extractStringField(block, cfg.namespaceField)?.trim();
        if (!namespace || namespace === "unknown" || namespace.toLowerCase() === "undefined") continue;

        const method = extractStringField(block, cfg.methodField);
        const actionName = extractStringField(block, "actionName");

        // Collect boolean flags that are set to true (e.g. isXmlResponse: true)
        const flagMatches = [...block.matchAll(/(\w+)\s*:\s*true/g)];
        const trueFlags = flagMatches.map((m) => m[1]).filter((f): f is string => !!f);

        const metadata: Record<string, string> = {};
        if (actionName) metadata["actionName"] = actionName;
        if (trueFlags.includes("isXmlResponse")) metadata["isXmlResponse"] = "true";
        const paramFlags = trueFlags.filter((f) => f !== "isXmlResponse");
        if (paramFlags.length > 0) metadata["parameterFlags"] = paramFlags.join(",");

        results.push({
          serviceNamespace: namespace,
          methodName: method ?? "unknown",
          callerFile: filePath,
          lineNumber: lineAt(content, match.index),
          metadata,
        });
      }

      return results;
    },
  };
}

// Default export — plugin with default configuration
const plugin = createPlugin();
export default plugin;
