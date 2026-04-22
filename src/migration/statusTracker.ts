import { promises as fs } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStatus =
  | "discovered"
  | "analyzed"
  | "in-progress"
  | "done";

export type Confidence = "high" | "medium" | "low" | "unknown";

export type ServiceRecord = {
  name: string;
  namespace: string;
  discoveredVia: string;
  sourceRepo: string;
  sourceFile: string;
  contextDoc: string;
  status: ServiceStatus;
  confidence: Confidence;
  analyzedAt: string | null;
  gitSha: string | null;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  rewrittenAt: string | null;
  databaseInteractions: string[];
  nestedServices: string[];
  notes: string;
};

export type MigrationStatus = {
  scannedAt: string;
  entryRepo: string;
  targetLanguage: string;
  services: ServiceRecord[];
};

export type ProgressSummary = {
  total: number;
  discovered: number;
  analyzed: number;
  inProgress: number;
  done: number;
  verified: number;
  unresolved: string[];
};

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

function statusPath(migrationDir: string): string {
  return join(migrationDir, "migration-status.json");
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export async function load(migrationDir: string): Promise<MigrationStatus | null> {
  try {
    const raw = await fs.readFile(statusPath(migrationDir), "utf-8");
    return JSON.parse(raw) as MigrationStatus;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export async function save(
  migrationDir: string,
  status: MigrationStatus
): Promise<void> {
  await fs.mkdir(migrationDir, { recursive: true });
  await fs.writeFile(
    statusPath(migrationDir),
    JSON.stringify(status, null, 2),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Init — create a fresh status file for a new scan
// ---------------------------------------------------------------------------

export async function init(
  migrationDir: string,
  entryRepo: string,
  targetLanguage: string
): Promise<MigrationStatus> {
  const status: MigrationStatus = {
    scannedAt: new Date().toISOString(),
    entryRepo,
    targetLanguage,
    services: [],
  };
  await save(migrationDir, status);
  return status;
}

// ---------------------------------------------------------------------------
// Upsert — add or update a single service record, then save immediately
// (checkpoint after every service so partial scans are recoverable)
// ---------------------------------------------------------------------------

export async function upsertService(
  migrationDir: string,
  service: ServiceRecord
): Promise<void> {
  const current = await load(migrationDir);
  if (!current) throw new Error("Migration status not initialized. Run init() first.");

  const idx = current.services.findIndex((s) => s.namespace === service.namespace);
  if (idx >= 0) {
    current.services[idx] = service;
  } else {
    current.services.push(service);
  }

  await save(migrationDir, current);
}

// ---------------------------------------------------------------------------
// Mark a service as verified
// ---------------------------------------------------------------------------

export async function markVerified(
  migrationDir: string,
  namespace: string,
  verifiedBy: string
): Promise<boolean> {
  const current = await load(migrationDir);
  if (!current) return false;

  const svc = current.services.find((s) => s.namespace === namespace);
  if (!svc) return false;

  svc.verified = true;
  svc.verifiedBy = verifiedBy;
  svc.verifiedAt = new Date().toISOString();
  if (svc.status === "analyzed") svc.status = "in-progress";

  await save(migrationDir, current);
  return true;
}

// ---------------------------------------------------------------------------
// Mark a service as done
// ---------------------------------------------------------------------------

export async function markDone(
  migrationDir: string,
  namespace: string
): Promise<boolean> {
  const current = await load(migrationDir);
  if (!current) return false;

  const svc = current.services.find((s) => s.namespace === namespace);
  if (!svc) return false;

  if (!svc.verified) {
    throw new Error(
      `Service "${namespace}" must be verified before it can be marked done. Run /migrate verify ${svc.name} first.`
    );
  }

  svc.status = "done";
  svc.rewrittenAt = new Date().toISOString();
  await save(migrationDir, current);
  return true;
}

// ---------------------------------------------------------------------------
// Check if a service has already been analyzed (idempotency check)
// ---------------------------------------------------------------------------

export async function isAnalyzed(
  migrationDir: string,
  namespace: string
): Promise<boolean> {
  const current = await load(migrationDir);
  if (!current) return false;
  const svc = current.services.find((s) => s.namespace === namespace);
  return svc != null && svc.status !== "discovered";
}

// ---------------------------------------------------------------------------
// Progress summary
// ---------------------------------------------------------------------------

export async function getProgress(migrationDir: string): Promise<ProgressSummary> {
  const current = await load(migrationDir);
  if (!current) {
    return { total: 0, discovered: 0, analyzed: 0, inProgress: 0, done: 0, verified: 0, unresolved: [] };
  }

  const summary: ProgressSummary = {
    total: current.services.length,
    discovered: 0,
    analyzed: 0,
    inProgress: 0,
    done: 0,
    verified: 0,
    unresolved: [],
  };

  for (const svc of current.services) {
    if (svc.status === "discovered") summary.discovered++;
    else if (svc.status === "analyzed") summary.analyzed++;
    else if (svc.status === "in-progress") summary.inProgress++;
    else if (svc.status === "done") summary.done++;
    if (svc.verified) summary.verified++;
    if (!svc.sourceRepo) summary.unresolved.push(svc.namespace);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Format progress as a terminal table string
// ---------------------------------------------------------------------------

export async function formatProgressTable(migrationDir: string): Promise<string> {
  const current = await load(migrationDir);
  if (!current || current.services.length === 0) {
    return "No services discovered yet. Run `/migrate scan` first.";
  }

  const progress = await getProgress(migrationDir);
  const header = [
    `Migration Progress — ${current.entryRepo}`,
    `Target: ${current.targetLanguage} | Scanned: ${current.scannedAt.slice(0, 10)}`,
    "",
    `Total: ${progress.total} | Done: ${progress.done} | In Progress: ${progress.inProgress} | Analyzed: ${progress.analyzed} | Discovered: ${progress.discovered}`,
    `Verified: ${progress.verified}/${progress.total}`,
    "",
    "Service".padEnd(30) + "Status".padEnd(14) + "Conf.".padEnd(8) + "Verified",
    "─".repeat(62),
  ];

  const rows = current.services.map((svc) => {
    const name = svc.name.slice(0, 28).padEnd(30);
    const status = svc.status.padEnd(14);
    const conf = (svc.confidence ?? "?").padEnd(8);
    const verified = svc.verified ? `✓ ${svc.verifiedBy ?? ""}` : "—";
    return `${name}${status}${conf}${verified}`;
  });

  const footer =
    progress.unresolved.length > 0
      ? [
          "",
          `⚠ Unresolved (${progress.unresolved.length}): ${progress.unresolved.join(", ")}`,
        ]
      : [];

  return [...header, ...rows, ...footer].join("\n");
}
