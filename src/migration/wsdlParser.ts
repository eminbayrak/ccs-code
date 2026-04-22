export type WsdlField = {
  name: string;
  type: string;
  required: boolean;
};

export type WsdlOperation = {
  name: string;
  inputMessage: string | null;
  outputMessage: string | null;
  inputFields: WsdlField[];
  outputFields: WsdlField[];
};

export type WsdlParseResult = {
  operations: WsdlOperation[];
  targetNamespace: string | null;
  serviceName: string | null;
};

// ---------------------------------------------------------------------------
// Attribute extractor
// ---------------------------------------------------------------------------

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`));
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Extract all elements matching a tag pattern (handles self-closing and paired)
// ---------------------------------------------------------------------------

function findTags(xml: string, tagName: string): string[] {
  const results: string[] = [];
  // Match self-closing: <tagName ... />
  const selfClose = new RegExp(`<(?:[a-z]+:)?${tagName}\\s[^>]*/\\s*>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = selfClose.exec(xml)) !== null) results.push(m[0]);

  // Match paired: <tagName ...>...</tagName>
  const openTag = new RegExp(`<(?:[a-z]+:)?${tagName}(\\s[^>]*)?>`, "gi");
  while ((m = openTag.exec(xml)) !== null) {
    const start = m.index;
    // find matching close tag
    const closePattern = new RegExp(`</(?:[a-z]+:)?${tagName}\\s*>`, "i");
    const closeMatch = xml.slice(start).match(closePattern);
    if (closeMatch) {
      results.push(xml.slice(start, start + closeMatch.index! + closeMatch[0].length));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Extract xs:element fields from a complexType block
// ---------------------------------------------------------------------------

function extractFields(block: string): WsdlField[] {
  const fields: WsdlField[] = [];
  const elementRegex = /<(?:[a-z]+:)?element\s([^>]+)(?:\/>|>)/gi;
  let m: RegExpExecArray | null;

  while ((m = elementRegex.exec(block)) !== null) {
    const tag = m[0];
    const name = attr(tag, "name");
    if (!name) continue;

    const type = attr(tag, "type") ?? "unknown";
    const minOccurs = attr(tag, "minOccurs");
    const required = minOccurs === null || minOccurs !== "0";

    fields.push({ name, type: type.replace(/^[a-z]+:/, ""), required });
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Build a map of message name → element fields from xs:element / xs:complexType
// ---------------------------------------------------------------------------

function buildMessageFieldMap(xml: string): Map<string, WsdlField[]> {
  const map = new Map<string, WsdlField[]>();

  // Find all xs:element or element blocks with names
  const elementBlocks = findTags(xml, "element");
  for (const block of elementBlocks) {
    const name = attr(block, "name");
    if (!name) continue;
    const fields = extractFields(block);
    if (fields.length > 0) map.set(name, fields);
  }

  // Also check xs:complexType blocks that might have a name
  const complexBlocks = findTags(xml, "complexType");
  for (const block of complexBlocks) {
    const name = attr(block, "name");
    if (!name) continue;
    const fields = extractFields(block);
    if (fields.length > 0 && !map.has(name)) map.set(name, fields);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Strip namespace prefix from a message ref like "tns:FooRequest" → "FooRequest"
// ---------------------------------------------------------------------------

function stripNs(ref: string | null): string | null {
  if (!ref) return null;
  return ref.replace(/^[a-z]+:/i, "");
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseWsdl(content: string): WsdlParseResult {
  // Normalise line endings
  const xml = content.replace(/\r\n/g, "\n");

  // Target namespace
  const nsMatch = xml.match(/targetNamespace\s*=\s*["']([^"']+)["']/);
  const targetNamespace = nsMatch?.[1] ?? null;

  // Service name
  const serviceMatch = xml.match(/<(?:[a-z]+:)?service\s[^>]*name\s*=\s*["']([^"']+)["']/i);
  const serviceName = serviceMatch ? attr(serviceMatch[0], "name") : null;

  // Build field map for message resolution
  const fieldMap = buildMessageFieldMap(xml);

  // Extract operations from portType / binding sections
  const operationBlocks = findTags(xml, "operation");
  const seen = new Set<string>();
  const operations: WsdlOperation[] = [];

  for (const block of operationBlocks) {
    const name = attr(block, "name");
    if (!name || seen.has(name)) continue;
    seen.add(name);

    // Input message ref
    const inputMatch = block.match(/<(?:[a-z]+:)?input\s([^>]+)>/i);
    const inputMsg = inputMatch ? stripNs(attr(inputMatch[0], "message")) : null;

    // Output message ref
    const outputMatch = block.match(/<(?:[a-z]+:)?output\s([^>]+)>/i);
    const outputMsg = outputMatch ? stripNs(attr(outputMatch[0], "message")) : null;

    operations.push({
      name,
      inputMessage: inputMsg,
      outputMessage: outputMsg,
      inputFields: inputMsg ? (fieldMap.get(inputMsg) ?? []) : [],
      outputFields: outputMsg ? (fieldMap.get(outputMsg) ?? []) : [],
    });
  }

  return { operations, targetNamespace, serviceName };
}

// ---------------------------------------------------------------------------
// Format a WsdlParseResult as a readable summary for the LLM prompt
// ---------------------------------------------------------------------------

export function wsdlToPromptText(result: WsdlParseResult): string {
  if (result.operations.length === 0) return "No WSDL operations found.";

  const lines: string[] = [];
  if (result.serviceName) lines.push(`Service: ${result.serviceName}`);

  for (const op of result.operations) {
    lines.push(`\nOperation: ${op.name}`);
    if (op.inputFields.length > 0) {
      lines.push("  Input fields:");
      for (const f of op.inputFields) {
        lines.push(`    - ${f.name}: ${f.type}${f.required ? "" : " (optional)"}`);
      }
    } else if (op.inputMessage) {
      lines.push(`  Input message: ${op.inputMessage}`);
    }
    if (op.outputFields.length > 0) {
      lines.push("  Output fields:");
      for (const f of op.outputFields) {
        lines.push(`    - ${f.name}: ${f.type}${f.required ? "" : " (optional)"}`);
      }
    } else if (op.outputMessage) {
      lines.push(`  Output message: ${op.outputMessage}`);
    }
  }

  return lines.join("\n");
}
