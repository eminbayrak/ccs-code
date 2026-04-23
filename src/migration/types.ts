// ---------------------------------------------------------------------------
// Core plugin contract for the /migrate feature
//
// Any team can build a scanner plugin by implementing MigratePlugin.
// The core app provides everything else: resolution, LLM analysis,
// context doc generation, status tracking, graph traversal.
// ---------------------------------------------------------------------------

/**
 * A service reference extracted from the entry repo by a scanner plugin.
 * serviceNamespace is what the resolver uses to find the service repo on GitHub.
 */
export type ServiceReference = {
  serviceNamespace: string;            // identifies the external service (used for GitHub search)
  methodName: string;                  // the specific operation being called
  callerFile: string;                  // file path where this reference was found
  lineNumber: number;                  // line number in the caller file
  metadata: Record<string, string>;   // plugin-specific extras (e.g. parameterFlags, isXmlResponse)
};

/**
 * The only interface a scanner plugin must implement.
 *
 * The plugin defines HOW to find service references in the codebase.
 * The core app handles everything that happens after discovery.
 *
 * Install a plugin by placing its folder in:
 *   .ccs/plugins/<plugin-name>/     (project-level)
 *   ~/.ccs/plugins/<plugin-name>/   (global)
 *
 * Each plugin folder needs:
 *   ccs-plugin.json   — manifest with name, version, description
 *   index.js          — compiled entry, default-exports a MigratePlugin object
 */
export interface MigratePlugin {
  name: string;
  version: string;
  description: string;

  /** File extensions this plugin can scan. e.g. ['.js', '.ts', '.jsx'] */
  fileExtensions: string[];

  /**
   * Scan a single file and return any service references found.
   * Return an empty array if no references are found in this file.
   * Must not throw — catch internally and return [] on error.
   */
  scan(filePath: string, content: string): ServiceReference[];
}

/**
 * Result of running a plugin scan across a set of files.
 */
export type ScanResult = {
  references: ServiceReference[];
  filesScanned: number;
  filesWithRefs: number;
};

/**
 * Groups service references by namespace.
 * Each unique namespace becomes one node in the dependency graph.
 */
export type ServiceGroup = Map<string, ServiceReference[]>;
