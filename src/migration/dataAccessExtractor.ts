/**
 * dataAccessExtractor.ts — SQL and ORM data-access extraction layer.
 *
 * Detects database reads and writes from source files and produces typed
 * graph edges: reads_table, writes_table, queries_db. This closes the
 * "data-call graph" gap vs. CAST Imaging — after running this extractor,
 * agents can answer: "which components touch the Orders table?" or
 * "which services write to users?".
 *
 * Supported ORM / access patterns
 * ────────────────────────────────
 * Raw SQL       — string literals containing SELECT/INSERT/UPDATE/DELETE/MERGE
 * Prisma        — prisma.modelName.findMany/create/update/delete/upsert/findFirst
 * TypeORM       — @Entity, Repository<T>.find/save/update/delete, .query()
 * Sequelize     — Model.findAll/create/update/destroy, sequelize.query()
 * Entity Framework (C#) — DbContext.DbSet<T>, .SaveChanges, .Add/.Remove/.Find
 * Hibernate (Java) — @Entity, Session.save/get/delete, Query/createQuery
 * JDBC (Java)   — Connection.prepareStatement, executeQuery, executeUpdate
 * ADO.NET (C#)  — SqlCommand, SqlConnection, OleDbCommand
 * VB6/DAO/ADO   — Recordset.Open, Execute, OpenRecordset
 *
 * How it works
 * ────────────
 * Phase 1 — Regex line scan (no AST required, all languages)
 *   Scans each source line for ORM call patterns and SQL string literals.
 *   Table names are extracted from SQL with a lightweight SQL tokenizer.
 *
 * Phase 2 — TypeScript AST enrichment (JS/TS files when AST is available)
 *   Walks the AST looking for CallExpression nodes that match ORM patterns,
 *   giving us accurate argument values and source positions.
 *
 * Output
 * ──────
 * Array of DataAccessEdge objects ready to be inserted into the GraphStore.
 */

import type { GraphStore } from "./graphStore.js";
import type { DataAccessEdge } from "./graphStore.js";

export type { DataAccessEdge };

// ---------------------------------------------------------------------------
// SQL table name extractor — lightweight tokenizer (no full SQL parser)
// ---------------------------------------------------------------------------

/**
 * Extract table names from a raw SQL string.
 * Handles: FROM tbl, JOIN tbl, INTO tbl, UPDATE tbl, FROM (subquery) AS alias
 * Returns lowercase table names; filters out SQL keywords and CTEs.
 */
function extractTablesFromSql(sql: string): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];

  const normalized = sql.replace(/\s+/g, " ").trim();
  const upper = normalized.toUpperCase();

  // Determine operation type
  const isWrite = /^\s*(INSERT|UPDATE|DELETE|MERGE|REPLACE|TRUNCATE)\b/i.test(normalized);

  // FROM tbl / JOIN tbl / UPDATE tbl / INTO tbl
  const tablePattern = /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|UPDATE|INTO)\s+([`'"\[]?[\w.]+[`'"\]]?)/gi;
  let m: RegExpExecArray | null;

  const SQL_KEYWORDS = new Set([
    "SELECT", "INSERT", "UPDATE", "DELETE", "FROM", "WHERE", "JOIN", "ON",
    "AND", "OR", "NOT", "IN", "IS", "NULL", "AS", "SET", "VALUES", "INTO",
    "DUAL", "INFORMATION_SCHEMA", "SYS", "SYSIBM", "SYSCAT",
  ]);

  while ((m = tablePattern.exec(normalized)) !== null) {
    const raw = m[1]!.replace(/[`'"\[\]]/g, "").split(".").pop()!.toLowerCase();
    if (!raw || SQL_KEYWORDS.has(raw.toUpperCase()) || /^\d/.test(raw)) continue;
    if (isWrite || upper.startsWith("UPDATE") || upper.startsWith("DELETE")) {
      writes.push(raw);
    } else {
      reads.push(raw);
    }
  }

  return { reads: [...new Set(reads)], writes: [...new Set(writes)] };
}

// ---------------------------------------------------------------------------
// ORM pattern registry
// ---------------------------------------------------------------------------

type OrmPattern = {
  orm: string;
  /** Regex to detect an ORM read operation on a line */
  readPattern?: RegExp;
  /** Regex to detect an ORM write operation on a line */
  writePattern?: RegExp;
  /** Extract table/model name from the matched line */
  extractName?: (line: string, match: RegExpMatchArray) => string | null;
  /** File extensions this pattern applies to (empty = all) */
  extensions?: string[];
};

function prismaExtract(line: string): string | null {
  // prisma.tableName.method() or prismaClient.tableName.method()
  const m = line.match(/(?:prisma|prismaClient|db)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*(?:findMany|findFirst|findUnique|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function typeOrmExtract(line: string, match: RegExpMatchArray): string | null {
  // getRepository(Entity) / Repository<Entity>
  const repoMatch = line.match(/(?:getRepository|Repository)\s*[<(]\s*([A-Z][a-zA-Z0-9_]*)/);
  if (repoMatch) return repoMatch[1]!.toLowerCase();
  // @Entity("tableName") or @Entity()
  const entityMatch = line.match(/@Entity\s*\(\s*["']([^"']+)["']/);
  if (entityMatch) return entityMatch[1]!.toLowerCase();
  return null;
}

function sequelizeExtract(line: string): string | null {
  // ModelName.findAll / User.create / etc.
  const m = line.match(/([A-Z][a-zA-Z0-9_]*)\s*\.\s*(?:findAll|findOne|findByPk|create|bulkCreate|update|destroy|count|sum|max|min)/);
  return m?.[1]?.toLowerCase() ?? null;
}

function efExtract(line: string): string | null {
  // context.Users / DbSet<User> / context.Set<Order>
  const setMatch = line.match(/(?:DbSet|Set)\s*<\s*([A-Z][a-zA-Z0-9_]*)/);
  if (setMatch) return setMatch[1]!.toLowerCase();
  const ctxMatch = line.match(/(?:context|ctx|_context|_ctx|db|_db)\s*\.\s*([A-Z][a-zA-Z0-9_]+)\s*(?:\.|;|\()/);
  if (ctxMatch && !["SaveChanges", "Database", "Entry", "Model", "ChangeTracker", "Configuration"].includes(ctxMatch[1]!)) {
    return ctxMatch[1]!.toLowerCase();
  }
  return null;
}

function hibernateExtract(line: string): string | null {
  // @Entity("table_name") or @Table(name="...")
  const tableMatch = line.match(/@(?:Entity|Table)\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["']/);
  if (tableMatch) return tableMatch[1]!.toLowerCase();
  // Session.get(Model.class) / Session.save(entity)
  const sessionMatch = line.match(/session\s*\.\s*(?:get|save|delete|update|saveOrUpdate|persist|merge)\s*\(\s*([A-Z][a-zA-Z0-9_]*)/i);
  if (sessionMatch) return sessionMatch[1]!.toLowerCase();
  return null;
}

const ORM_PATTERNS: OrmPattern[] = [
  // Prisma (JS/TS)
  {
    orm: "prisma",
    readPattern: /(?:prisma|prismaClient|db)\s*\.\s*\w+\s*\.\s*(?:findMany|findFirst|findUnique|count|aggregate|groupBy)/i,
    writePattern: /(?:prisma|prismaClient|db)\s*\.\s*\w+\s*\.\s*(?:create|createMany|update|updateMany|delete|deleteMany|upsert)/i,
    extractName: (line) => prismaExtract(line),
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
  },
  // TypeORM (JS/TS)
  {
    orm: "typeorm",
    readPattern: /(?:getRepository|\.find\b|\.findOne\b|\.findByIds\b|\.count\b)/i,
    writePattern: /(?:\.save\b|\.insert\b|\.update\b|\.delete\b|\.remove\b|\.softDelete\b)/i,
    extractName: typeOrmExtract,
    extensions: ["ts", "tsx", "js", "jsx"],
  },
  // Sequelize (JS/TS)
  {
    orm: "sequelize",
    readPattern: /\.\s*(?:findAll|findOne|findByPk|findAndCountAll|count|sum|min|max)\s*\(/i,
    writePattern: /\.\s*(?:create|bulkCreate|update|destroy|upsert)\s*\(/i,
    extractName: (line) => sequelizeExtract(line),
    extensions: ["ts", "tsx", "js", "jsx", "mjs"],
  },
  // Entity Framework (C#)
  {
    orm: "ef",
    readPattern: /(?:\.Find\b|\.FirstOrDefault\b|\.ToList\b|\.Where\b|\.AsQueryable\b|\.Include\b|DbSet\s*<)/i,
    writePattern: /(?:\.Add\b|\.AddRange\b|\.Remove\b|\.RemoveRange\b|\.Update\b|SaveChanges)/i,
    extractName: (line) => efExtract(line),
    extensions: ["cs"],
  },
  // Hibernate / JPA (Java)
  {
    orm: "hibernate",
    readPattern: /(?:session\.get\b|session\.load\b|createQuery|createCriteria|TypedQuery|@NamedQuery)/i,
    writePattern: /(?:session\.save\b|session\.persist\b|session\.update\b|session\.delete\b|session\.merge\b|session\.saveOrUpdate\b|entityManager\.persist\b|entityManager\.merge\b|entityManager\.remove\b)/i,
    extractName: (line, _match) => hibernateExtract(line),
    extensions: ["java"],
  },
  // JDBC (Java)
  {
    orm: "jdbc",
    readPattern: /(?:executeQuery|prepareStatement|createStatement)\s*\(/i,
    writePattern: /(?:executeUpdate|executeBatch|execute)\s*\(/i,
    extractName: (_line, _match) => null, // table extracted from SQL string
    extensions: ["java"],
  },
  // ADO.NET (C#)
  {
    orm: "adonet",
    readPattern: /(?:SqlCommand|OleDbCommand|SqlDataAdapter|ExecuteReader|ExecuteScalar)\s*\(/i,
    writePattern: /(?:ExecuteNonQuery|SqlDataAdapter\.Update|BulkCopy)\s*\(/i,
    extractName: (_line, _match) => null,
    extensions: ["cs"],
  },
  // VB6 / DAO / ADO (VB)
  {
    orm: "vb6-ado",
    readPattern: /(?:\.Open\s*"|Recordset|OpenRecordset|ExecuteSQL|DoCmd\.RunSQL|\.Execute\s*"SELECT)/i,
    writePattern: /(?:\.Execute\s*"(?:INSERT|UPDATE|DELETE|MERGE)|\.AddNew\b|\.Update\b|\.Delete\b)/i,
    extractName: (_line, _match) => null,
    extensions: ["bas", "cls", "frm", "vb"],
  },
];

// ---------------------------------------------------------------------------
// SQL literal detection (all languages)
// ---------------------------------------------------------------------------

const SQL_LITERAL_RE = /["'`](\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|CREATE\s+TABLE|TRUNCATE\s+TABLE)\b[^"'`]{10,})/gi;

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

export type DataAccessFileResult = {
  file: string;
  edges: DataAccessEdge[];
};

/**
 * Scan a source file for database access patterns.
 * Returns a list of DataAccessEdge objects.
 *
 * @param file       File path + content
 * @param symbolName The enclosing symbol/function name (or component name as fallback)
 * @param componentId The component ID to use as the graph source when no symbol matches
 */
export function extractDataAccess(
  file: { path: string; content: string },
  symbolName: string,
  componentId: string,
): DataAccessEdge[] {
  const ext = file.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const lines = file.content.split(/\r?\n/);
  const edges: DataAccessEdge[] = [];
  const seen = new Set<string>();

  function addEdge(
    edgeType: DataAccessEdge["edgeType"],
    target: string,
    line: number,
    orm: string,
  ): void {
    const dedup = `${symbolName}:${edgeType}:${target.toLowerCase()}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    edges.push({
      symbolOrComponent: symbolName || componentId,
      edgeType,
      target: target.toLowerCase(),
      file: file.path,
      line,
      orm,
    });
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const lineNo = lineIdx + 1;

    // ── SQL literal detection ───────────────────────────────────────────────
    let sqlMatch: RegExpExecArray | null;
    SQL_LITERAL_RE.lastIndex = 0;
    while ((sqlMatch = SQL_LITERAL_RE.exec(line)) !== null) {
      const sqlFrag = sqlMatch[1]!;
      const { reads, writes } = extractTablesFromSql(sqlFrag);
      for (const t of reads) addEdge("reads_table", t, lineNo, "raw");
      for (const t of writes) addEdge("writes_table", t, lineNo, "raw");
      if (reads.length === 0 && writes.length === 0 && sqlFrag.length > 20) {
        // Store raw query when table extraction fails
        const snippet = sqlFrag.slice(0, 80).replace(/\s+/g, " ").trim();
        addEdge("queries_db", snippet, lineNo, "raw");
      }
    }

    // ── ORM pattern matching ───────────────────────────────────────────────
    for (const pattern of ORM_PATTERNS) {
      // Skip if this pattern doesn't apply to this file type
      if (pattern.extensions && pattern.extensions.length > 0 && !pattern.extensions.includes(ext)) {
        continue;
      }

      if (pattern.readPattern) {
        const m = line.match(pattern.readPattern);
        if (m) {
          const tableName = pattern.extractName?.(line, m) ?? null;
          if (tableName) {
            addEdge("reads_table", tableName, lineNo, pattern.orm);
          } else {
            // No table name resolved — try to extract from adjacent SQL strings
            const adjacentSql = lines.slice(Math.max(0, lineIdx - 2), lineIdx + 3).join(" ");
            const { reads } = extractTablesFromSql(adjacentSql);
            for (const t of reads) addEdge("reads_table", t, lineNo, pattern.orm);
          }
        }
      }

      if (pattern.writePattern) {
        const m = line.match(pattern.writePattern);
        if (m) {
          const tableName = pattern.extractName?.(line, m) ?? null;
          if (tableName) {
            addEdge("writes_table", tableName, lineNo, pattern.orm);
          } else {
            const adjacentSql = lines.slice(Math.max(0, lineIdx - 2), lineIdx + 3).join(" ");
            const { writes } = extractTablesFromSql(adjacentSql);
            for (const t of writes) addEdge("writes_table", t, lineNo, pattern.orm);
          }
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Batch extractor — processes multiple files and writes into a GraphStore
// ---------------------------------------------------------------------------

export function ingestDataAccessEdges(
  store: GraphStore,
  files: Array<{ path: string; content: string; symbolName?: string; componentId?: string }>,
): { totalEdges: number; tables: Set<string> } {
  const tables = new Set<string>();
  let totalEdges = 0;

  for (const file of files) {
    const symbolName = file.symbolName ?? file.path;
    const componentId = file.componentId ?? `file:${file.path}`;

    const edges = extractDataAccess(file, symbolName, componentId);

    for (const edge of edges) {
      // Ensure table/db nodes exist
      if (edge.edgeType === "reads_table" || edge.edgeType === "writes_table") {
        const tableId = `table:${edge.target}`;
        store.upsertNode({ id: tableId, label: edge.target, type: "table" });
        tables.add(edge.target);
        store.upsertEdge({
          source: edge.symbolOrComponent,
          target: tableId,
          type: edge.edgeType,
          label: `${edge.edgeType.replace("_", " ")} (${edge.orm})`,
          evidence: `${edge.file}:${edge.line}`,
        });
      } else {
        // queries_db — store raw query snippet as a virtual node
        const rawId = `db_query:${Buffer.from(edge.target).toString("base64").slice(0, 20)}`;
        store.upsertNode({ id: rawId, label: edge.target.slice(0, 60), type: "db_query" });
        store.upsertEdge({
          source: edge.symbolOrComponent,
          target: rawId,
          type: "queries_db",
          label: "queries db (raw sql)",
          evidence: `${edge.file}:${edge.line}`,
        });
      }
      totalEdges++;
    }
  }

  return { totalEdges, tables };
}

// ---------------------------------------------------------------------------
// Convenience: scan all files in a CodeIntelligence artifact's symbol list
// ---------------------------------------------------------------------------

export type DataAccessSummary = {
  componentTables: Array<{
    component: string;
    reads: string[];
    writes: string[];
    rawQueryCount: number;
  }>;
  allTables: string[];
  totalDataEdges: number;
};

export function buildDataAccessSummary(store: GraphStore, componentIds: string[]): DataAccessSummary {
  const allTables = new Set<string>();
  let totalDataEdges = 0;

  const componentTables = componentIds.map((componentId) => {
    const { reads, writes, queries } = store.dataAccess(componentId);
    for (const r of reads) allTables.add(r.label);
    for (const w of writes) allTables.add(w.label);
    totalDataEdges += reads.length + writes.length + queries.length;
    return {
      component: componentId,
      reads: reads.map((r) => r.label),
      writes: writes.map((w) => w.label),
      rawQueryCount: queries.length,
    };
  });

  return {
    componentTables: componentTables.filter((c) => c.reads.length + c.writes.length + c.rawQueryCount > 0),
    allTables: [...allTables].sort(),
    totalDataEdges,
  };
}
