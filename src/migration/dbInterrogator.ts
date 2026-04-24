// ---------------------------------------------------------------------------
// Database interrogator — Feature 4 from features.md
//
// Two-phase approach:
//
//  Phase 1 — Static analysis (safe, automatic):
//    Parse legacy source files to extract DB dialect, table names, SQL queries,
//    ORM configurations, and connection patterns.
//    This runs as part of the normal scan — no user approval needed.
//
//  Phase 2 — Live interrogation (user-approved, opt-in):
//    The tool NEVER auto-executes connection strings found in source code.
//    User must explicitly approve by running `/migrate db --service <name>`.
//    Credentials are requested via masked input.
//    Only structural metadata (schema) is extracted — never row data.
//
// Supported databases: PostgreSQL, MySQL/MariaDB, MS SQL Server, SQLite, Oracle (limited)
// ---------------------------------------------------------------------------

import { promises as fs } from "fs";
import { join } from "path";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Phase 1 — Static database analysis
// ---------------------------------------------------------------------------

export type DbDialect = "mssql" | "postgresql" | "mysql" | "oracle" | "sqlite" | "unknown";

export type StaticDbFinding = {
  dialect: DbDialect;
  tables: string[];
  queries: string[];
  ormHints: string[];
  connectionPatterns: string[];
  confidence: "high" | "medium" | "low";
};

const DIALECT_PATTERNS: Array<{ dialect: DbDialect; patterns: RegExp[] }> = [
  {
    dialect: "mssql",
    patterns: [
      /SqlConnection|SqlCommand|SqlDataAdapter/i,
      /Data Source\s*=|Initial Catalog\s*=/i,
      /provider=sqlclient|System\.Data\.SqlClient/i,
      /\bSELECT\b.*\bFROM\b.*\bWITH\s*\(NOLOCK\)/i,
      /master\.dbo\.|sys\.objects|sp_executesql/i,
    ],
  },
  {
    dialect: "postgresql",
    patterns: [
      /NpgsqlConnection|NpgsqlCommand|Npgsql/i,
      /Host\s*=.*Database\s*=/i,
      /postgresql:|psycopg2|asyncpg|pg\./i,
      /\$\d+\b/,    // PostgreSQL positional params
      /SERIAL|BIGSERIAL|TEXT\s+NOT\s+NULL/i,
    ],
  },
  {
    dialect: "mysql",
    patterns: [
      /MySqlConnection|MySqlCommand|MySql\.Data/i,
      /Server\s*=.*Database\s*=.*Uid\s*=/i,
      /mysql:|mysqlconnector|pymysql|mysql2/i,
      /AUTO_INCREMENT|ENGINE\s*=\s*InnoDB/i,
    ],
  },
  {
    dialect: "oracle",
    patterns: [
      /OracleConnection|OracleCommand|Oracle\.DataAccess/i,
      /Data Source\s*=.*User Id\s*=/i,
      /cx_Oracle|oracledb|oracle-db/i,
      /\bROWNUM\b|\bSYSDATE\b|\bNVL\s*\(/i,
    ],
  },
  {
    dialect: "sqlite",
    patterns: [
      /SQLiteConnection|SQLiteCommand|System\.Data\.SQLite/i,
      /sqlite3|aiosqlite|better-sqlite3/i,
      /\.sqlite|\.db3\b/i,
    ],
  },
];

const TABLE_EXTRACT_RE = /\bFROM\s+([`"\[]?[\w.]+[`"\]]?)|\bJOIN\s+([`"\[]?[\w.]+[`"\]]?)|\bINTO\s+([`"\[]?[\w.]+[`"\]]?)|\bUPDATE\s+([`"\[]?[\w.]+[`"\]]?)/gi;
const QUERY_LINE_RE = /\b(SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE|sp_[A-Za-z]+)\b.{10,}/gi;
const ORM_PATTERNS = [
  { re: /EntityFramework|DbContext|IDbSet/i, hint: "Entity Framework" },
  { re: /Dapper\.|QueryAsync|ExecuteAsync/i, hint: "Dapper" },
  { re: /NHibernate|ISession\b/i, hint: "NHibernate" },
  { re: /hibernate\.cfg|@Entity\s|@Table\s/i, hint: "Hibernate (JPA)" },
  { re: /SqlAlchemy|declarative_base|Column\(/i, hint: "SQLAlchemy" },
  { re: /ActiveRecord::Base|belongs_to|has_many/i, hint: "ActiveRecord" },
  { re: /mongoose\.|Schema\s*\(|model\s*\(/i, hint: "Mongoose" },
  { re: /prisma\.|PrismaClient/i, hint: "Prisma" },
  { re: /typeorm|@Entity\(\)|@Column\(\)/i, hint: "TypeORM" },
];

export function analyzeDbStatic(
  files: Array<{ path: string; content: string }>,
): StaticDbFinding {
  const combinedContent = files.map((f) => f.content).join("\n");

  // Detect dialect
  let dialect: DbDialect = "unknown";
  let dialectScore = 0;
  for (const { dialect: d, patterns } of DIALECT_PATTERNS) {
    const score = patterns.filter((re) => re.test(combinedContent)).length;
    if (score > dialectScore) { dialectScore = score; dialect = d; }
  }

  // Extract table names
  const tables = new Set<string>();
  TABLE_EXTRACT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_EXTRACT_RE.exec(combinedContent)) !== null) {
    const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").replace(/[`"\[\]]/g, "").trim();
    if (name && !name.match(/^(SELECT|FROM|WHERE|JOIN|ON|AND|OR)$/i)) {
      // Strip schema prefix for shorter display (but keep it)
      tables.add(name);
    }
  }

  // Extract representative queries (first 20)
  const queries: string[] = [];
  QUERY_LINE_RE.lastIndex = 0;
  while ((m = QUERY_LINE_RE.exec(combinedContent)) !== null && queries.length < 20) {
    const q = m[0]!.slice(0, 200).replace(/\s+/g, " ").trim();
    if (!queries.some((existing) => existing.includes(q.slice(0, 40)))) {
      queries.push(q);
    }
  }

  // Detect ORM
  const ormHints = ORM_PATTERNS
    .filter(({ re }) => re.test(combinedContent))
    .map(({ hint }) => hint);

  // Extract connection string patterns (redacted)
  const connPatterns: string[] = [];
  const connRe = /(?:connectionString|ConnectionString|Data Source|Server|Host)\s*[=:]\s*["']?([^"'\n;]{5,60})/gi;
  while ((m = connRe.exec(combinedContent)) !== null && connPatterns.length < 5) {
    const redacted = m[0]!
      .replace(/Password\s*=[^;'"]+/gi, "Password=***")
      .replace(/pwd\s*=[^;'"]+/gi, "pwd=***")
      .replace(/User\s+Id\s*=[^;'"]+/gi, "User Id=***")
      .slice(0, 120);
    if (!connPatterns.includes(redacted)) connPatterns.push(redacted);
  }

  const confidence: "high" | "medium" | "low" =
    dialectScore >= 3 ? "high" : dialectScore >= 1 ? "medium" : "low";

  return {
    dialect,
    tables: [...tables].slice(0, 50),
    queries: queries.slice(0, 20),
    ormHints,
    connectionPatterns: connPatterns,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Static analysis markdown renderer (for KB)
// ---------------------------------------------------------------------------

export function renderStaticDbSection(finding: StaticDbFinding): string {
  const lines = [
    `## Database Analysis (Static)`,
    ``,
    `**Dialect detected:** ${finding.dialect} (confidence: ${finding.confidence})`,
  ];

  if (finding.ormHints.length > 0) {
    lines.push(`**ORM/Access layer:** ${finding.ormHints.join(", ")}`);
  }

  if (finding.tables.length > 0) {
    lines.push(``, `### Tables Referenced`, ``);
    for (const t of finding.tables) lines.push(`- \`${t}\``);
  }

  if (finding.queries.length > 0) {
    lines.push(``, `### Representative Queries`, ``);
    for (const q of finding.queries) lines.push(`\`\`\`sql\n${q}\n\`\`\``);
  }

  if (finding.connectionPatterns.length > 0) {
    lines.push(
      ``,
      `### Connection Patterns Found`,
      ``,
      `> ⚠️ Credentials redacted. Never use production connection strings directly.`,
      ``,
    );
    for (const c of finding.connectionPatterns) lines.push(`- \`${c}\``);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 2 — Live interrogation
// ---------------------------------------------------------------------------

export type DbCredentials = {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  dialect: DbDialect;
  connectionString?: string;
};

export type TableSchema = {
  tableName: string;
  columns: Array<{ name: string; type: string; nullable: boolean; isPrimaryKey: boolean }>;
};

export type LiveSchemaResult = {
  credentials: Omit<DbCredentials, "password">;
  tables: TableSchema[];
  outputPath: string;
};

// ---------------------------------------------------------------------------
// Secure masked input via readline
// ---------------------------------------------------------------------------

export async function promptMasked(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    process.stdout.write(prompt);

    // Disable echo
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }

    let value = "";
    const onData = (char: Buffer | string) => {
      const str = char.toString();
      if (str === "\r" || str === "\n") {
        process.stdout.write("\n");
        if (stdin.setRawMode) stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        rl.close();
        resolve(value);
      } else if (str === "") {
        process.stdout.write("\n");
        if (stdin.setRawMode) stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        rl.close();
        resolve("");
      } else if (str === "" || str === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        value += str;
        process.stdout.write("*");
      }
    };

    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

async function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function collectCredentials(dialectHint: DbDialect): Promise<DbCredentials | null> {
  console.log("\n⚠️  READ-ONLY CREDENTIALS ONLY. Do not enter admin or write-access credentials.");
  console.log("   This tool will ONLY read schema metadata — no table data will be accessed.\n");

  const useConnStr = await promptLine("Do you have a connection string? [y/N]: ");
  if (useConnStr.toLowerCase() === "y") {
    const connectionString = await promptMasked("Connection string (masked): ");
    if (!connectionString) return null;

    // Parse dialect from connection string
    let dialect = dialectHint;
    if (/postgresql|postgres/i.test(connectionString)) dialect = "postgresql";
    else if (/sqlserver|mssql|initial catalog/i.test(connectionString)) dialect = "mssql";
    else if (/mysql/i.test(connectionString)) dialect = "mysql";

    const hostMatch = connectionString.match(/(?:Host|Server|Data Source)\s*=\s*([^;,]+)/i);
    const dbMatch = connectionString.match(/(?:Database|Initial Catalog)\s*=\s*([^;,]+)/i);

    return {
      host: hostMatch?.[1]?.trim() ?? "unknown",
      port: dialect === "postgresql" ? 5432 : dialect === "mysql" ? 3306 : 1433,
      database: dbMatch?.[1]?.trim() ?? "unknown",
      username: "from-connection-string",
      password: "from-connection-string",
      dialect,
      connectionString,
    };
  }

  const host = await promptLine(`DB Host [localhost]: `) || "localhost";
  const portStr = await promptLine(`Port [${dialectHint === "postgresql" ? "5432" : dialectHint === "mysql" ? "3306" : "1433"}]: `);
  const port = parseInt(portStr) || (dialectHint === "postgresql" ? 5432 : dialectHint === "mysql" ? 3306 : 1433);
  const database = await promptLine("Database name: ");
  if (!database) return null;
  const username = await promptLine("Username (read-only): ");
  if (!username) return null;
  const password = await promptMasked("Password (masked): ");
  if (!password) return null;

  return { host, port, database, username, password, dialect: dialectHint };
}

// ---------------------------------------------------------------------------
// Schema extraction — per dialect using dynamic driver imports
// ---------------------------------------------------------------------------

// All three schema extractor functions use dynamic optional imports.
// The packages (pg, mssql, mysql2) are NOT required dependencies — if missing,
// the user gets a helpful install instruction rather than a crash.
// We cast to `unknown` then to a minimal interface to avoid TypeScript errors.

type PgLike = {
  default?: { Client: new (cfg: unknown) => PgClientLike };
  Client?: new (cfg: unknown) => PgClientLike;
};
type PgClientLike = {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};

async function extractPostgresSchema(creds: DbCredentials, tables: string[]): Promise<TableSchema[]> {
  let pgMod: PgLike;
  try {
    // @ts-ignore — optional peer dependency
    pgMod = await import("pg") as unknown as PgLike;
  } catch {
    throw new Error("pg package not installed. Run: bun add pg @types/pg");
  }

  const PgClient = (pgMod.default?.Client ?? pgMod.Client)!;
  const client = new PgClient(
    creds.connectionString
      ? { connectionString: creds.connectionString }
      : { host: creds.host, port: creds.port, database: creds.database, user: creds.username, password: creds.password }
  );

  await client.connect();
  const result: TableSchema[] = [];

  const targetTables = tables.length > 0 ? tables : await (async () => {
    const r = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' LIMIT 100"
    );
    return r.rows.map((row) => String(row["table_name"]));
  })();

  for (const tableName of targetTables.slice(0, 50)) {
    const cleanName = tableName.split(".").pop() ?? tableName;
    try {
      const cols = await client.query(`
        SELECT c.column_name, c.data_type, c.is_nullable,
               (SELECT COUNT(*) FROM information_schema.key_column_usage k
                JOIN information_schema.table_constraints tc ON k.constraint_name = tc.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY' AND k.table_name = c.table_name AND k.column_name = c.column_name) > 0 AS is_pk
        FROM information_schema.columns c
        WHERE c.table_name = $1 AND c.table_schema = 'public'
        ORDER BY c.ordinal_position
      `, [cleanName]);

      result.push({
        tableName,
        columns: cols.rows.map((row) => ({
          name: String(row["column_name"]),
          type: String(row["data_type"]),
          nullable: row["is_nullable"] === "YES",
          isPrimaryKey: Boolean(row["is_pk"]),
        })),
      });
    } catch { /* table not accessible — skip */ }
  }

  await client.end();
  return result;
}

type MssqlLike = {
  default?: { connect(cfg: unknown): Promise<MssqlPoolLike> };
  connect?(cfg: unknown): Promise<MssqlPoolLike>;
};
type MssqlPoolLike = {
  request(): { query(sql: string): Promise<{ recordset: Record<string, unknown>[] }> };
  close(): Promise<void>;
};

async function extractMssqlSchema(creds: DbCredentials, tables: string[]): Promise<TableSchema[]> {
  let mssqlMod: MssqlLike;
  try {
    // @ts-ignore — optional peer dependency
    mssqlMod = await import("mssql") as unknown as MssqlLike;
  } catch {
    throw new Error("mssql package not installed. Run: bun add mssql");
  }

  const connectFn = (mssqlMod.default?.connect ?? mssqlMod.connect)!.bind(mssqlMod.default ?? mssqlMod);
  const pool = await connectFn(
    creds.connectionString ?? {
      server: creds.host,
      port: creds.port,
      database: creds.database,
      user: creds.username,
      password: creds.password,
      options: { encrypt: true, trustServerCertificate: true },
    }
  );

  const result: TableSchema[] = [];
  const targetTables = tables.length > 0 ? tables : await (async () => {
    const r = await pool.request().query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'"
    );
    return r.recordset.map((row) => String(row["TABLE_NAME"]));
  })();

  for (const tableName of targetTables.slice(0, 50)) {
    const cleanName = tableName.split(".").pop()?.replace(/[\[\]]/g, "") ?? tableName;
    try {
      const r = await pool.request().query(`
        SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
               CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = '${cleanName}'
        ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
        WHERE c.TABLE_NAME = '${cleanName}'
        ORDER BY c.ORDINAL_POSITION
      `);
      result.push({
        tableName,
        columns: r.recordset.map((row) => ({
          name: String(row["COLUMN_NAME"]),
          type: String(row["DATA_TYPE"]),
          nullable: row["IS_NULLABLE"] === "YES",
          isPrimaryKey: Boolean(row["IS_PK"]),
        })),
      });
    } catch { /* skip */ }
  }

  await pool.close();
  return result;
}

type Mysql2Like = {
  default?: { createConnection(cfg: unknown): Promise<Mysql2ConnLike> };
  createConnection?(cfg: unknown): Promise<Mysql2ConnLike>;
};
type Mysql2ConnLike = {
  query(sql: string): Promise<[Record<string, unknown>[], unknown]>;
  end(): Promise<void>;
};

async function extractMysqlSchema(creds: DbCredentials, tables: string[]): Promise<TableSchema[]> {
  let mysql2Mod: Mysql2Like;
  try {
    // @ts-ignore — optional peer dependency
    mysql2Mod = await import("mysql2/promise") as unknown as Mysql2Like;
  } catch {
    throw new Error("mysql2 package not installed. Run: bun add mysql2");
  }

  const createConn = (mysql2Mod.default?.createConnection ?? mysql2Mod.createConnection)!.bind(mysql2Mod.default ?? mysql2Mod);
  const conn = await createConn({
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.username,
    password: creds.password,
  });

  const result: TableSchema[] = [];
  const targetTables = tables.length > 0 ? tables : await (async () => {
    const [rows] = await conn.query("SHOW TABLES");
    return (rows as Array<Record<string, string>>).map((r) => Object.values(r)[0]!);
  })();

  for (const tableName of targetTables.slice(0, 50)) {
    try {
      const [cols] = await conn.query(`DESCRIBE \`${tableName}\``);
      result.push({
        tableName,
        columns: (cols as Array<Record<string, unknown>>).map((c) => ({
          name: String(c["Field"]),
          type: String(c["Type"]),
          nullable: c["Null"] === "YES",
          isPrimaryKey: c["Key"] === "PRI",
        })),
      });
    } catch { /* skip */ }
  }

  await conn.end();
  return result;
}

// ---------------------------------------------------------------------------
// Schema markdown renderer
// ---------------------------------------------------------------------------

export function renderSchemaDoc(tables: TableSchema[], dialect: DbDialect): string {
  const lines = [
    `# Database Schema`,
    ``,
    `**Dialect:** ${dialect}`,
    `**Tables extracted:** ${tables.length}`,
    ``,
    `> Schema extracted with read-only credentials. No row data was accessed.`,
    ``,
    `---`,
    ``,
  ];

  for (const table of tables) {
    lines.push(`## \`${table.tableName}\``);
    lines.push(``, `| Column | Type | Nullable | PK |`, `|--------|------|----------|----|`);
    for (const col of table.columns) {
      const pk = col.isPrimaryKey ? "✓" : "";
      const nullable = col.nullable ? "YES" : "NO";
      lines.push(`| \`${col.name}\` | \`${col.type}\` | ${nullable} | ${pk} |`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 2 public entry point
// ---------------------------------------------------------------------------

export async function runLiveInterrogation(
  staticFinding: StaticDbFinding,
  outputDir: string,
  onProgress?: (msg: string) => void,
): Promise<LiveSchemaResult | null> {
  const dialect = staticFinding.dialect === "unknown" ? "postgresql" : staticFinding.dialect;

  onProgress?.("Collecting database credentials (read-only)...");
  const creds = await collectCredentials(dialect);
  if (!creds) {
    onProgress?.("DB interrogation cancelled.");
    return null;
  }

  onProgress?.(`Connecting to ${creds.dialect} at ${creds.host}...`);

  let tables: TableSchema[];
  try {
    switch (creds.dialect) {
      case "postgresql":
        tables = await extractPostgresSchema(creds, staticFinding.tables);
        break;
      case "mssql":
        tables = await extractMssqlSchema(creds, staticFinding.tables);
        break;
      case "mysql":
        tables = await extractMysqlSchema(creds, staticFinding.tables);
        break;
      default:
        throw new Error(`Live interrogation not yet supported for dialect: ${creds.dialect}. Extract schema manually.`);
    }
  } catch (e) {
    onProgress?.(`DB connection failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  const doc = renderSchemaDoc(tables, creds.dialect);
  const outputPath = join(outputDir, "db-schema.md");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, doc, "utf-8");

  onProgress?.(`Schema extracted: ${tables.length} tables → ${outputPath}`);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password: _p, ...safeCreds } = creds;
  return { credentials: safeCreds, tables, outputPath };
}
