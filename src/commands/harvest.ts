import { MinerService, type MemoryEntry } from '../services/miner.js';
import { readVaultConfig } from './vault.js';
import { join } from 'path';
import * as fs from 'fs/promises';

export interface HarvestResult {
  total: number;
  byTool: Record<string, number>;
  newFiles: string[];
}

export async function runHarvest(): Promise<HarvestResult> {
  const miner = new MinerService();
  const config = await readVaultConfig();
  
  if (!config.activeVault) {
    throw new Error("No active vault configured. Run /vault init first.");
  }

  const results: HarvestResult = {
    total: 0,
    byTool: {
      claude: 0,
      vscode: 0,
      cursor: 0,
      antigravity: 0,
      windsurf: 0
    },
    newFiles: []
  };

  const harvestTasks = [
    { name: 'claude', fn: () => miner.harvestClaude() },
    { name: 'vscode', fn: () => miner.harvestVSCode() },
    { name: 'cursor', fn: () => miner.harvestCursor() },
    { name: 'antigravity', fn: () => miner.harvestAntigravity() },
    { name: 'windsurf', fn: () => miner.harvestWindsurf() }
  ];

  for (const task of harvestTasks) {
    try {
      const memories = await task.fn();
      results.byTool[task.name] = memories.length;
      results.total += memories.length;

      for (const mem of memories) {
        const filePath = join(config.activeVault, 'raw', 'memories', task.name, `${mem.sessionId}.md`);
        
        // Check if exists to avoid overwriting/duplicates if we want
        const exists = await fs.stat(filePath).catch(() => null);
        if (!exists) {
          const markdown = formatMemoryToMarkdown(mem);
          await fs.mkdir(join(config.activeVault, 'raw', 'memories', task.name), { recursive: true });
          await fs.writeFile(filePath, markdown, 'utf-8');
          results.newFiles.push(filePath);
        }
      }
    } catch (e) {
      console.error(`Failed to harvest ${task.name}:`, e);
    }
  }

  return results;
}

export async function handleHarvestCommand(args: string[], cwd: string): Promise<string> {
  try {
    const res = await runHarvest();
    let output = `### Harvest Complete! 💎\n\n`;
    output += `Gathered **${res.total}** total memories:\n`;
    output += `- Claude Code: ${res.byTool.claude}\n`;
    output += `- VS Code Copilot: ${res.byTool.vscode}\n`;
    output += `- Cursor: ${res.byTool.cursor}\n`;
    output += `- Antigravity: ${res.byTool.antigravity}\n`;
    output += `- Windsurf: ${res.byTool.windsurf}\n\n`;

    if (res.newFiles.length > 0) {
      output += `Added **${res.newFiles.length}** new memory files to \`raw/memories/\`.\n`;
      output += `Run \`/ingest\` to integrate them into your wiki!`;
    } else {
      output += `No new memories found. Everything is already up to date.`;
    }
    return output;
  } catch (e: any) {
    return `### Harvest Failed ❌\n\n${e.message}`;
  }
}

function formatMemoryToMarkdown(mem: MemoryEntry): string {
  let md = `---\n`;
  md += `tool: ${mem.tool}\n`;
  md += `sessionId: ${mem.sessionId}\n`;
  md += `timestamp: ${mem.timestamp}\n`;
  md += `type: memory\n`;
  md += `---\n\n`;

  md += `# Conversation Memory - ${mem.tool} (${mem.sessionId})\n\n`;

  for (const msg of mem.messages) {
    const roleName = msg.role === 'user' ? 'USER' : 'AI';
    md += `### ${roleName}\n\n${msg.content}\n\n---\n\n`;
  }

  return md;
}
