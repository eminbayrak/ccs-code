// plugins/migrate-soap/index.ts
var DEFAULT_CONFIG = {
  callerFunctionName: "constructSoapRequest",
  namespaceField: "serviceNamespace",
  methodField: "methodName"
};
function findClosingParen(content, openAt) {
  let depth = 0;
  for (let i = openAt;i < content.length; i++) {
    if (content[i] === "(")
      depth++;
    else if (content[i] === ")") {
      depth--;
      if (depth === 0)
        return i;
    }
  }
  return content.length - 1;
}
function extractStringField(block, field) {
  const pattern = new RegExp(`['"\\s]?${field}['"]?\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
  return block.match(pattern)?.[1] ?? null;
}
function lineAt(content, charIndex) {
  return content.slice(0, charIndex).split(`
`).length;
}
function createPlugin(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return {
    name: "migrate-soap",
    version: "1.0.0",
    description: "Scans for SOAP service call patterns and extracts namespace/method references.",
    fileExtensions: [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"],
    scan(filePath, content) {
      const results = [];
      const fnEscaped = cfg.callerFunctionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const callPattern = new RegExp(`${fnEscaped}\\s*\\(`, "g");
      let match;
      while ((match = callPattern.exec(content)) !== null) {
        const openParen = match.index + match[0].length - 1;
        const closeParen = findClosingParen(content, openParen);
        const block = content.slice(openParen + 1, closeParen);
        const namespace = extractStringField(block, cfg.namespaceField);
        if (!namespace)
          continue;
        const method = extractStringField(block, cfg.methodField);
        const actionName = extractStringField(block, "actionName");
        const flagMatches = [...block.matchAll(/(\w+)\s*:\s*true/g)];
        const trueFlags = flagMatches.map((m) => m[1]).filter((f) => !!f);
        const metadata = {};
        if (actionName)
          metadata["actionName"] = actionName;
        if (trueFlags.includes("isXmlResponse"))
          metadata["isXmlResponse"] = "true";
        const paramFlags = trueFlags.filter((f) => f !== "isXmlResponse");
        if (paramFlags.length > 0)
          metadata["parameterFlags"] = paramFlags.join(",");
        results.push({
          serviceNamespace: namespace,
          methodName: method ?? "unknown",
          callerFile: filePath,
          lineNumber: lineAt(content, match.index),
          metadata
        });
      }
      return results;
    }
  };
}
var plugin = createPlugin();
var migrate_soap_default = plugin;
export {
  migrate_soap_default as default,
  createPlugin
};
