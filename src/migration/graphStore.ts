/**
 * graphStore.ts — SQLite-backed property graph for CCS migration intelligence.
 *
 * Replaces flat JSON array scanning with an indexed adjacency store that
 * supports O(1) edge lookups and true multi-hop BFS/DFS traversal. Uses
 * `bun:sqlite` (zero install, built into Bun runtime) with a graceful
 * fallback to an in-memory JS map when running outside Bun (e.g. tests
 * running under Node via ts-node).
 *
 * Schema
 * ──────
 * nodes (id TEXT PK, label TEXT, type TEXT, metadata TEXT)
 * edges (id INTEGER PK, source TEXT, target TEXT, type TEXT, label TEXT,
 *        evidence TEXT, weight REAL)
 *
 * Edge types used by CCS
 * ──────────────────────
 *  depends_on         — component → component
 *  declares_symbol    — component → symbol
 *  calls              — symbol → symbol
 *  implements         — class_symbol → interface_symbol   (type-flow)
 *  reads_table        — symbol/component → table_node
 *  writes_table       — symbol/component → table_node
 *  queries_db         — symbol/component → db_node (raw SQL, unresolved table)
 *  defined_in         — component → file_node
 *  recommended_role   — component → role_node
 *  uses_package       — component → package_node
 */

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GraphNode = {
  id: string;
  label: string;
  type: string;
  metadata?: Record<string, unknown>;
};

export type GraphEdge = {
  id?: number;
  source: string;
  target: string;
  type: string;
  label?: string;
  evidence?: string;
  weight?: number;
};

export type BfsResult = {
  id: string;
  label: string;
  type: string;
  distance: number;
  via?: string; // edge type that led here
};

export type DataAccessEdge = {
  symbolOrComponent: string;
  edgeType: "reads_table" | "writes_table" | "queries_db";
  target: string; // table name or raw SQL snippet
  file: string;
  line: number;
  orm?: string; // "prisma" | "typeorm" | "sequelize" | "ef" | "hibernate" | "raw"
};

// ---------------------------------------------------------------------------
// SQLite adapter — bun:sqlite when available, in-memory fallback otherwise
// ---------------------------------------------------------------------------

type SqliteDb = {
  query: (sql: string) => { all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => void; get: (...args: unknown[]) => unknown };
  exec: (sql: string) => void;
  close: () => void;
};

function openSqlite(path: string): SqliteDb | null {
  try {
    // bun:sqlite is only available in Bun runtime
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require("bun:sqlite") as { Database: new (path: string) => SqliteDb };
    return new Database(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback graph (for Node.js / test environments)
// ---------------------------------------------------------------------------

class MemoryGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private edgeCounter = 0;

  upsertNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  upsertEdge(edge: GraphEdge): void {
    // Deduplicate by source+target+type
    const exists = this.edges.find(
      (e) => e.source === edge.source && e.target === edge.target && e.type === edge.type,
    );
    if (!exists) {
      this.edges.push({ ...edge, id: ++this.edgeCounter });
    }
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getNodes(type?: string): GraphNode[] {
    const all = [...this.nodes.values()];
    return type ? all.filter((n) => n.type === type) : all;
  }

  getEdges(opts: { source?: string; target?: string; type?: string }): GraphEdge[] {
    return this.edges.filter(
      (e) =>
        (!opts.source || e.source === opts.source) &&
        (!opts.target || e.target === opts.target) &&
        (!opts.type || e.type === opts.type),
    );
  }

  bfs(startIds: string[], direction: "out" | "in", edgeTypes: string[], maxDepth: number): BfsResult[] {
    const seen = new Set<string>(startIds);
    const queue: Array<{ id: string; distance: number; via?: string }> = startIds.map((id) => ({ id, distance: 0 }));
    const result: BfsResult[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.distance >= maxDepth) continue;

      const nextEdges = this.edges.filter((e) => {
        const matchDir = direction === "out" ? e.source === current.id : e.target === current.id;
        const matchType = edgeTypes.length === 0 || edgeTypes.includes(e.type);
        return matchDir && matchType;
      });

      for (const edge of nextEdges) {
        const nextId = direction === "out" ? edge.target : edge.source;
        if (!nextId || seen.has(nextId)) continue;
        seen.add(nextId);
        const node = this.nodes.get(nextId);
        const item: BfsResult = {
          id: nextId,
          label: node?.label ?? nextId,
          type: node?.type ?? "unknown",
          distance: current.distance + 1,
          via: edge.type,
        };
        result.push(item);
        queue.push({ id: nextId, distance: current.distance + 1, via: edge.type });
      }
    }
    return result;
  }

  toJSON(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return { nodes: this.getNodes(), edges: this.edges };
  }

  close(): void {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// SqliteGraph — full implementation backed by bun:sqlite
// ---------------------------------------------------------------------------

class SqliteGraph {
  private db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id       TEXT PRIMARY KEY,
        label    TEXT NOT NULL,
        type     TEXT NOT NULL DEFAULT 'unknown',
        metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS edges (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        source   TEXT NOT NULL,
        target   TEXT NOT NULL,
        type     TEXT NOT NULL,
        label    TEXT,
        evidence TEXT,
        weight   REAL DEFAULT 1.0
      );
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source, type);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target, type);
      CREATE INDEX IF NOT EXISTS idx_edges_type   ON edges(type);
    `);
  }

  upsertNode(node: GraphNode): void {
    this.db.query(
      `INSERT INTO nodes (id, label, type, metadata)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, type=excluded.type, metadata=excluded.metadata`
    ).run(node.id, node.label, node.type, node.metadata ? JSON.stringify(node.metadata) : null);
  }

  upsertEdge(edge: GraphEdge): void {
    // Skip if exact duplicate already exists
    const exists = this.db.query(
      `SELECT id FROM edges WHERE source=? AND target=? AND type=? LIMIT 1`
    ).get(edge.source, edge.target, edge.type);
    if (exists) return;

    this.db.query(
      `INSERT INTO edges (source, target, type, label, evidence, weight)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(edge.source, edge.target, edge.type, edge.label ?? null, edge.evidence ?? null, edge.weight ?? 1.0);
  }

  getNode(id: string): GraphNode | undefined {
    const row = this.db.query(`SELECT id, label, type, metadata FROM nodes WHERE id=?`).get(id) as
      | { id: string; label: string; type: string; metadata: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      label: row.label,
      type: row.type,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    };
  }

  getNodes(type?: string): GraphNode[] {
    const rows = (
      type
        ? this.db.query(`SELECT id, label, type, metadata FROM nodes WHERE type=?`).all(type)
        : this.db.query(`SELECT id, label, type, metadata FROM nodes`).all()
    ) as Array<{ id: string; label: string; type: string; metadata: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      type: row.type,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    }));
  }

  getEdges(opts: { source?: string; target?: string; type?: string }): GraphEdge[] {
    let sql = `SELECT id, source, target, type, label, evidence, weight FROM edges WHERE 1=1`;
    const params: unknown[] = [];
    if (opts.source) { sql += ` AND source=?`; params.push(opts.source); }
    if (opts.target) { sql += ` AND target=?`; params.push(opts.target); }
    if (opts.type)   { sql += ` AND type=?`;   params.push(opts.type);   }
    return (this.db.query(sql).all(...params) as Array<{
      id: number; source: string; target: string; type: string;
      label: string | null; evidence: string | null; weight: number;
    }>).map((row) => ({
      id: row.id,
      source: row.source,
      target: row.target,
      type: row.type,
      label: row.label ?? undefined,
      evidence: row.evidence ?? undefined,
      weight: row.weight,
    }));
  }

  bfs(startIds: string[], direction: "out" | "in", edgeTypes: string[], maxDepth: number): BfsResult[] {
    const seen = new Set<string>(startIds);
    const queue: Array<{ id: string; distance: number; via?: string }> = startIds.map((id) => ({ id, distance: 0 }));
    const result: BfsResult[] = [];

    const typeFilter = edgeTypes.length > 0
      ? `AND type IN (${edgeTypes.map(() => "?").join(",")})`
      : "";
    const outSql = `SELECT target AS next, type AS via FROM edges WHERE source=? ${typeFilter} LIMIT 500`;
    const inSql  = `SELECT source AS next, type AS via FROM edges WHERE target=? ${typeFilter} LIMIT 500`;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.distance >= maxDepth) continue;

      const sql = direction === "out" ? outSql : inSql;
      const rows = this.db.query(sql).all(current.id, ...edgeTypes) as Array<{ next: string; via: string }>;

      for (const row of rows) {
        if (!row.next || seen.has(row.next)) continue;
        seen.add(row.next);
        const node = this.getNode(row.next);
        const item: BfsResult = {
          id: row.next,
          label: node?.label ?? row.next,
          type: node?.type ?? "unknown",
          distance: current.distance + 1,
          via: row.via,
        };
        result.push(item);
        queue.push({ id: row.next, distance: current.distance + 1 });
      }
    }
    return result;
  }

  toJSON(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return { nodes: this.getNodes(), edges: this.getEdges({}) };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Public API — GraphStore wraps either SQLite or in-memory fallback
// ---------------------------------------------------------------------------

export class GraphStore {
  private impl: SqliteGraph | MemoryGraph;
  readonly dbPath: string | null;

  constructor(impl: SqliteGraph | MemoryGraph, dbPath: string | null) {
    this.impl = impl;
    this.dbPath = dbPath;
  }

  static open(storageDir: string, name = "graph.db"): GraphStore {
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
    const dbPath = join(storageDir, name);
    const db = openSqlite(dbPath);
    if (db) {
      return new GraphStore(new SqliteGraph(db), dbPath);
    }
    // Bun not available — use in-memory fallback
    return new GraphStore(new MemoryGraph(), null);
  }

  /** Open a transient in-memory graph (useful for loading from existing JSON) */
  static inMemory(): GraphStore {
    return new GraphStore(new MemoryGraph(), null);
  }

  /** Load an existing flat system-graph.json into the store */
  static fromSystemGraph(json: {
    nodes?: Array<{ id?: string; label?: string; type?: string; metadata?: Record<string, unknown> }>;
    edges?: Array<{ source?: string; target?: string; type?: string; label?: string; evidence?: string }>;
  }, storageDir?: string): GraphStore {
    const store = storageDir ? GraphStore.open(storageDir) : GraphStore.inMemory();
    for (const node of json.nodes ?? []) {
      if (node.id) {
        store.upsertNode({
          id: node.id,
          label: node.label ?? node.id,
          type: node.type ?? "unknown",
          metadata: node.metadata,
        });
      }
    }
    for (const edge of json.edges ?? []) {
      if (edge.source && edge.target && edge.type) {
        store.upsertEdge({
          source: edge.source,
          target: edge.target,
          type: edge.type,
          label: edge.label,
          evidence: edge.evidence,
        });
      }
    }
    return store;
  }

  upsertNode(node: GraphNode): void { this.impl.upsertNode(node); }
  upsertEdge(edge: GraphEdge): void { this.impl.upsertEdge(edge); }
  getNode(id: string): GraphNode | undefined { return this.impl.getNode(id); }
  getNodes(type?: string): GraphNode[] { return this.impl.getNodes(type); }
  getEdges(opts: { source?: string; target?: string; type?: string }): GraphEdge[] { return this.impl.getEdges(opts); }

  /**
   * Multi-hop BFS from one or more start nodes.
   * @param startIds  Node IDs to start from
   * @param direction "out" = follow outgoing edges, "in" = follow incoming edges
   * @param edgeTypes Edge type filter; empty array = all types
   * @param maxDepth  Maximum hops (clamped to 1–10)
   */
  bfs(startIds: string[], direction: "out" | "in", edgeTypes: string[] = [], maxDepth = 3): BfsResult[] {
    const depth = Math.max(1, Math.min(10, maxDepth));
    return this.impl.bfs(startIds, direction, edgeTypes, depth);
  }

  /** Compute blast radius: all nodes transitively reachable from startId via depends_on (in = dependents) */
  blastRadius(startId: string, maxDepth = 4): BfsResult[] {
    return this.bfs([startId], "in", ["depends_on"], maxDepth);
  }

  /** Find all transitive dependencies of startId */
  transitiveDependencies(startId: string, maxDepth = 4): BfsResult[] {
    return this.bfs([startId], "out", ["depends_on"], maxDepth);
  }

  /** Return all table nodes a component reads or writes (transitively through its symbols) */
  dataAccess(componentId: string): { reads: GraphNode[]; writes: GraphNode[]; queries: GraphEdge[] } {
    // Direct edges from component
    const directReads = this.getEdges({ source: componentId, type: "reads_table" });
    const directWrites = this.getEdges({ source: componentId, type: "writes_table" });

    // Via declared symbols
    const symbolIds = this.getEdges({ source: componentId, type: "declares_symbol" }).map((e) => e.target);
    const symbolReads = symbolIds.flatMap((sid) => this.getEdges({ source: sid, type: "reads_table" }));
    const symbolWrites = symbolIds.flatMap((sid) => this.getEdges({ source: sid, type: "writes_table" }));
    const rawQueries = symbolIds.flatMap((sid) => this.getEdges({ source: sid, type: "queries_db" }));

    const readTargets = [...new Set([...directReads, ...symbolReads].map((e) => e.target))];
    const writeTargets = [...new Set([...directWrites, ...symbolWrites].map((e) => e.target))];

    return {
      reads: readTargets.map((id) => this.getNode(id) ?? { id, label: id, type: "table" }),
      writes: writeTargets.map((id) => this.getNode(id) ?? { id, label: id, type: "table" }),
      queries: rawQueries,
    };
  }

  /** Resolve concrete implementations of an interface symbol */
  implementations(interfaceId: string): GraphNode[] {
    const edges = this.getEdges({ target: interfaceId, type: "implements" });
    return edges.map((e) => this.getNode(e.source) ?? { id: e.source, label: e.source, type: "class" });
  }

  /** Export as plain JSON (compatible with system-graph.json format) */
  toJSON(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return this.impl.toJSON();
  }

  close(): void { this.impl.close(); }
}
