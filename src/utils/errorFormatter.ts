import chalk from "chalk";

/**
 * Formats an error into a beautiful Markdown-style dump for the terminal.
 * Inspired by the Claude Code CLI error presentation.
 */
export function formatErrorDump(error: unknown, context?: string): string {
  const e = error instanceof Error ? error : new Error(String(error));
  const lines: string[] = [];

  lines.push(`### ❌ Error${context ? `: ${context}` : ""}`);
  lines.push("");
  
  // Primary message
  lines.push(`> [!CAUTION]`);
  lines.push(`> **${e.message}**`);
  lines.push("");

  // Diagnostic Info
  lines.push("#### Diagnostic Details");
  lines.push("```json");
  const details = {
    timestamp: new Date().toISOString(),
    name: e.name,
    message: e.message,
    // Add stack only if not a clean user-facing error
    stack: e.stack?.split("\n").slice(0, 5).join("\n") + "\n...",
  };
  lines.push(JSON.stringify(details, null, 2));
  lines.push("```");
  lines.push("");

  // Suggestion
  if (e.message.includes("401") || e.message.includes("unauthorized")) {
    lines.push("#### 💡 Troubleshooting Suggestion");
    lines.push("- Check your API keys and Client IDs in the `.env` file.");
    lines.push("- Ensure the provider (e.g., UHG, OpenAI) is reachable and your token hasn't expired.");
  } else if (e.message.includes("ENOENT")) {
    lines.push("#### 💡 Troubleshooting Suggestion");
    lines.push("- The app couldn't find a file or directory. Verify your vault path is correct.");
  }

  return lines.join("\n");
}
