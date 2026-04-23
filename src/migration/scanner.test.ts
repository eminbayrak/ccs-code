import { expect, test, describe } from "bun:test";
import { createPlugin } from "../../plugins/migrate-soap/index.js";
import { runPluginScan, groupByNamespace } from "./scanner.js";

const plugin = createPlugin();

// ---------------------------------------------------------------------------
// Plugin scanner — happy paths
// ---------------------------------------------------------------------------

describe("migrate-soap plugin", () => {
  test("finds a single call with both fields", () => {
    const content = `
      const result = constructSoapRequest({
        serviceNamespace: "OrderManager",
        methodName: "GetOrder",
        orderId: req.params.id,
      });
    `;
    const refs = plugin.scan("src/order.ts", content);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.serviceNamespace).toBe("OrderManager");
    expect(refs[0]?.methodName).toBe("GetOrder");
    expect(refs[0]?.callerFile).toBe("src/order.ts");
    expect(refs[0]?.lineNumber).toBeGreaterThan(0);
  });

  test("finds multiple calls in one file", () => {
    const content = `
      constructSoapRequest({ serviceNamespace: "FooManager", methodName: "GetFoo" });
      constructSoapRequest({ serviceNamespace: "BarManager", methodName: "GetBar" });
    `;
    const refs = plugin.scan("src/multi.ts", content);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.serviceNamespace)).toEqual(["FooManager", "BarManager"]);
  });

  test("extracts isXmlResponse flag into metadata", () => {
    const content = `constructSoapRequest({ serviceNamespace: "XmlSvc", methodName: "Get", isXmlResponse: true });`;
    const refs = plugin.scan("f.ts", content);
    expect(refs[0]?.metadata["isXmlResponse"]).toBe("true");
  });

  test("extracts parameterFlags into metadata", () => {
    const content = `constructSoapRequest({ serviceNamespace: "FlagSvc", methodName: "Run", includeSsn: true, maskDob: true });`;
    const refs = plugin.scan("f.ts", content);
    const flags = refs[0]?.metadata["parameterFlags"]?.split(",") ?? [];
    expect(flags).toContain("includeSsn");
    expect(flags).toContain("maskDob");
  });

  test("skips call with no serviceNamespace field", () => {
    const content = `constructSoapRequest({ methodName: "Orphan" });`;
    const refs = plugin.scan("f.ts", content);
    expect(refs).toHaveLength(0);
  });

  test("returns empty array for files with no calls", () => {
    const refs = plugin.scan("src/util.ts", "export const add = (a: number, b: number) => a + b;");
    expect(refs).toHaveLength(0);
  });

  test("handles nested parens inside the call block", () => {
    const content = `
      constructSoapRequest({
        serviceNamespace: "PatientManager",
        methodName: "Search",
        filters: buildFilters(req.query),
      });
    `;
    const refs = plugin.scan("src/patient.ts", content);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.serviceNamespace).toBe("PatientManager");
  });

  test("configurable function name", () => {
    const custom = createPlugin({ callerFunctionName: "callService" });
    const content = `callService({ serviceNamespace: "Acme", methodName: "DoThing" });`;
    const refs = custom.scan("f.ts", content);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.serviceNamespace).toBe("Acme");
  });

  test("configurable field names", () => {
    const custom = createPlugin({ namespaceField: "ns", methodField: "method" });
    const content = `constructSoapRequest({ ns: "Custom", method: "Execute" });`;
    const refs = custom.scan("f.ts", content);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.serviceNamespace).toBe("Custom");
    expect(refs[0]?.methodName).toBe("Execute");
  });

  test("default plugin does not match custom function name", () => {
    const content = `callService({ serviceNamespace: "Ignored", methodName: "Skip" });`;
    const refs = plugin.scan("f.ts", content);
    expect(refs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runPluginScan — extension filtering
// ---------------------------------------------------------------------------

describe("runPluginScan", () => {
  test("only scans files matching fileExtensions", () => {
    const files = [
      { path: "src/api.ts", content: `constructSoapRequest({ serviceNamespace: "A", methodName: "M" });` },
      { path: "src/styles.css", content: `constructSoapRequest({ serviceNamespace: "B", methodName: "N" });` },
    ];
    const result = runPluginScan(files, plugin);
    expect(result.filesScanned).toBe(1);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.serviceNamespace).toBe("A");
  });

  test("counts filesWithRefs correctly", () => {
    const files = [
      { path: "a.ts", content: `constructSoapRequest({ serviceNamespace: "X", methodName: "Y" });` },
      { path: "b.ts", content: "export const x = 1;" },
    ];
    const result = runPluginScan(files, plugin);
    expect(result.filesScanned).toBe(2);
    expect(result.filesWithRefs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// groupByNamespace
// ---------------------------------------------------------------------------

describe("groupByNamespace", () => {
  test("groups references by serviceNamespace", () => {
    const refs = [
      { serviceNamespace: "Svc", methodName: "A", callerFile: "f.ts", lineNumber: 1, metadata: {} },
      { serviceNamespace: "Svc", methodName: "B", callerFile: "g.ts", lineNumber: 5, metadata: {} },
      { serviceNamespace: "Other", methodName: "C", callerFile: "h.ts", lineNumber: 2, metadata: {} },
    ];
    const grouped = groupByNamespace(refs);
    expect(grouped.size).toBe(2);
    expect(grouped.get("Svc")).toHaveLength(2);
    expect(grouped.get("Other")).toHaveLength(1);
  });
});
