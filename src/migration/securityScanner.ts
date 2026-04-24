// ---------------------------------------------------------------------------
// Pre-LLM security scanner
//
// Scans source files for credentials/secrets BEFORE sending them to the LLM.
// Purpose: (1) warn the user, (2) optionally redact so secrets don't leave
// the machine embedded in LLM prompts or context docs.
//
// Inspired by Repomix's @secretlint integration, implemented without
// external deps so it works everywhere Bun runs.
// ---------------------------------------------------------------------------

export interface SecretFinding {
  file: string;
  line: number;
  column: number;
  pattern: string;
  severity: "critical" | "high";
  snippet: string; // redacted, never the raw secret
}

// ---------------------------------------------------------------------------
// Pattern registry — each entry describes one class of secret
// ---------------------------------------------------------------------------

interface SecretPattern {
  name: string;
  severity: "critical" | "high";
  // Regex matched against each line of file content
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // Cloud provider keys
  {
    name: "AWS Access Key ID",
    severity: "critical",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "AWS Secret Access Key",
    severity: "critical",
    regex: /(?:aws[_\-.]?secret|AWS_SECRET)[_\-.]?(?:access[_\-.]?)?key\s*[=:]\s*["']?[A-Za-z0-9/+]{40}["']?/i,
  },
  {
    name: "GitHub Personal Access Token",
    severity: "critical",
    regex: /\bghp_[A-Za-z0-9_]{36}\b/,
  },
  {
    name: "GitHub OAuth Token",
    severity: "critical",
    regex: /\bgho_[A-Za-z0-9_]{36}\b/,
  },
  {
    name: "Google API Key",
    severity: "critical",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/,
  },
  {
    name: "Stripe Secret Key",
    severity: "critical",
    regex: /\bsk_live_[0-9a-zA-Z]{24,}\b/,
  },
  {
    name: "Stripe Test Key",
    severity: "high",
    regex: /\bsk_test_[0-9a-zA-Z]{24,}\b/,
  },
  {
    name: "Anthropic API Key",
    severity: "critical",
    regex: /\bsk-ant-[0-9a-zA-Z\-_]{80,}\b/,
  },
  {
    name: "OpenAI API Key",
    severity: "critical",
    regex: /\bsk-[a-zA-Z0-9]{20,}\b/,
  },
  // Private keys and certificates
  {
    name: "RSA/EC/DSA Private Key",
    severity: "critical",
    regex: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "PEM Certificate",
    severity: "high",
    regex: /-----BEGIN CERTIFICATE-----/,
  },
  // Database connection strings
  {
    name: "DB Connection String with Password",
    severity: "critical",
    regex: /(?:password|pwd|passwd)\s*=\s*(?!["']{2})["']?[^;\s"']{6,}["']?/i,
  },
  {
    name: "JDBC/ADO.NET Connection String",
    severity: "critical",
    regex: /(?:jdbc:|Data Source=|Server=)[^;"\n]{10,}password\s*=/i,
  },
  // Generic hardcoded credential assignments
  {
    name: "Hardcoded API Key Assignment",
    severity: "high",
    regex: /(?:api[_\-.]?key|apikey|api[_\-.]?secret)\s*(?:=|:)\s*["'][A-Za-z0-9_\-./+]{16,}["']/i,
  },
  {
    name: "Hardcoded Secret/Token Assignment",
    severity: "high",
    regex: /(?:secret|token|auth[_\-.]?key|access[_\-.]?token)\s*(?:=|:)\s*["'][A-Za-z0-9_\-./+]{16,}["']/i,
  },
];

// ---------------------------------------------------------------------------
// Redact a matched secret for display — never log the raw value
// ---------------------------------------------------------------------------

function redact(line: string, match: RegExpMatchArray): string {
  const raw = match[0] ?? "";
  // Keep first 4 + last 2 chars of the secret portion, mask the rest
  const eqIdx = raw.search(/[=:]\s*["']?/);
  if (eqIdx === -1) {
    // The whole match is the secret (e.g. AKIA…)
    return raw.length > 8
      ? `${raw.slice(0, 4)}${"*".repeat(raw.length - 6)}${raw.slice(-2)}`
      : "****";
  }
  const prefix = raw.slice(0, eqIdx + 1);
  const value = raw.slice(eqIdx + 1).replace(/^["'\s]+/, "").replace(/["'\s]+$/, "");
  const masked = value.length > 6
    ? `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}`
    : "****";
  return `${prefix} <REDACTED:${masked}>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a single file's content for secrets.
 * Returns findings with redacted snippets — never exposes raw secret values.
 */
export function scanForSecrets(
  filePath: string,
  content: string,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Skip comment-only lines — too many false positives
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("<!--")
    ) {
      continue;
    }

    for (const pat of SECRET_PATTERNS) {
      const match = line.match(pat.regex);
      if (!match) continue;

      findings.push({
        file: filePath,
        line: i + 1,
        column: (match.index ?? 0) + 1,
        pattern: pat.name,
        severity: pat.severity,
        snippet: redact(line.trim(), match),
      });
    }
  }

  return findings;
}

/**
 * Scan a batch of files and return all findings grouped by severity.
 */
export function scanFilesForSecrets(
  files: Array<{ path: string; content: string }>,
): SecretFinding[] {
  return files.flatMap((f) => scanForSecrets(f.path, f.content));
}

/**
 * Format findings for terminal display.
 */
export function formatSecurityWarnings(findings: SecretFinding[]): string {
  if (findings.length === 0) return "";

  const critical = findings.filter((f) => f.severity === "critical");
  const high = findings.filter((f) => f.severity === "high");

  const lines: string[] = [
    "",
    "⚠  Security Scanner — Potential Secrets Detected",
    "─────────────────────────────────────────────────",
  ];

  for (const f of [...critical, ...high]) {
    const tag = f.severity === "critical" ? "[CRITICAL]" : "[HIGH]    ";
    lines.push(`${tag} ${f.pattern}`);
    lines.push(`          ${f.file}:${f.line}  →  ${f.snippet}`);
  }

  lines.push("─────────────────────────────────────────────────");
  lines.push(
    `${critical.length} critical, ${high.length} high — these files will still be analyzed.`,
  );
  lines.push(
    "Review the context docs before sharing and remove secrets from your source code.",
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Return true if any critical-severity secrets were found.
 */
export function hasCriticalSecrets(findings: SecretFinding[]): boolean {
  return findings.some((f) => f.severity === "critical");
}
