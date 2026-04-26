import { Database } from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';

export interface MemoryEntry {
  tool: 'claude' | 'vscode' | 'cursor' | 'antigravity' | 'windsurf';
  sessionId: string;
  timestamp: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

export class MinerService {
  private getVSCodePath(): string {
    if (process.platform === "win32") {
      return join(process.env.APPDATA || "", "Code", "User", "workspaceStorage");
    }
    if (process.platform === "linux") {
      return join(homedir(), ".config", "Code", "User", "workspaceStorage");
    }
    return join(homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
  }

  private getVSCodeGlobalPath(): string {
    if (process.platform === "win32") {
      return join(process.env.APPDATA || "", "Code", "User", "globalStorage");
    }
    if (process.platform === "linux") {
      return join(homedir(), ".config", "Code", "User", "globalStorage");
    }
    return join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage");
  }

  private getCursorPath(): string {
    if (process.platform === "win32") {
      return join(process.env.APPDATA || "", "Cursor", "User", "workspaceStorage");
    }
    if (process.platform === "linux") {
      return join(homedir(), ".config", "Cursor", "User", "workspaceStorage");
    }
    return join(homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage");
  }

  /**
   * Harvests memories from Claude Code
   */
  async harvestClaude(): Promise<MemoryEntry[]> {
    const memories: MemoryEntry[] = [];
    const claudePath = join(homedir(), '.claude', 'projects');

    try {
      const projects = await fs.readdir(claudePath).catch(() => []);
      for (const project of projects) {
        const projectPath = join(claudePath, project);
        const stats = await fs.stat(projectPath);
        if (!stats.isDirectory()) continue;

        const files = await fs.readdir(projectPath);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;

          const content = await fs.readFile(join(projectPath, file), 'utf-8');
          const lines = content.trim().split('\n');
          const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
          let sessionId = file.replace('.jsonl', '');
          let timestamp = new Date().toISOString();

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'user' && entry.message?.content) {
                messages.push({ role: 'user', content: entry.message.content });
                if (entry.timestamp) timestamp = entry.timestamp;
              } else if (entry.type === 'assistant' && entry.message?.content) {
                // Assistant content can be array or string in Claude
                let text = '';
                if (Array.isArray(entry.message.content)) {
                  text = entry.message.content.map((c: any) => c.text || '').join('\n');
                } else {
                  text = entry.message.content;
                }
                if (text) messages.push({ role: 'assistant', content: text });
              }
            } catch (e) {
              // Skip malformed lines
            }
          }

          if (messages.length > 0) {
            memories.push({
              tool: 'claude',
              sessionId,
              timestamp,
              messages
            });
          }
        }
      }
    } catch (e) {
      console.error('Error harvesting Claude:', e);
    }

    return memories;
  }

  /**
   * Harvests memories from Antigravity (this app's brain)
   */
  async harvestAntigravity(): Promise<MemoryEntry[]> {
    const memories: MemoryEntry[] = [];
    const antiPath = join(homedir(), '.gemini', 'antigravity', 'brain');

    try {
      const sessions = await fs.readdir(antiPath).catch(() => []);
      for (const sessionId of sessions) {
        const logPath = join(antiPath, sessionId, '.system_generated', 'logs', 'overview.txt');
        try {
          const content = await fs.readFile(logPath, 'utf-8');
          const lines = content.trim().split('\n');
          const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
          let timestamp = new Date().toISOString();

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'USER_INPUT' && entry.content) {
                // Strip metadata tags if present
                const cleanContent = entry.content.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>[\s\S]*/, '$1').trim();
                messages.push({ role: 'user', content: cleanContent || entry.content });
                if (entry.created_at) timestamp = entry.created_at;
              } else if (entry.type === 'PLANNER_RESPONSE' && entry.content) {
                messages.push({ role: 'assistant', content: entry.content });
              }
            } catch (e) { }
          }

          if (messages.length > 0) {
            memories.push({
              tool: 'antigravity',
              sessionId,
              timestamp,
              messages
            });
          }
        } catch (e) { }
      }
    } catch (e) {
      console.error('Error harvesting Antigravity:', e);
    }

    return memories;
  }

  /**
   * Harvests memories from Cursor (state.vscdb)
   */
  async harvestCursor(): Promise<MemoryEntry[]> {
    const memories: MemoryEntry[] = [];
    const cursorPath = this.getCursorPath();

    try {
      const workspaces = await fs.readdir(cursorPath).catch(() => []);
      for (const workspace of workspaces) {
        const dbPath = join(cursorPath, workspace, "state.vscdb");
        try {
          const stats = await fs.stat(dbPath).catch(() => null);
          if (!stats) continue;

          const db = new Database(dbPath);
          
          // 1. Check aiService.generations (User prompts)
          const genRows = db.query("SELECT value FROM ItemTable WHERE key = 'aiService.generations'").all() as any[];
          for (const row of genRows) {
            try {
              const gens = JSON.parse(row.value);
              if (Array.isArray(gens)) {
                for (const gen of gens) {
                  if (gen.textDescription) {
                    memories.push({
                      tool: "cursor",
                      sessionId: gen.generationUUID || workspace,
                      timestamp: gen.unixMs ? new Date(gen.unixMs).toISOString() : new Date().toISOString(),
                      messages: [{ role: "user", content: gen.textDescription }]
                    });
                  }
                }
              }
            } catch (e) {}
          }

          // 2. Check composer.composerData
          const compRows = db.query("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").all() as any[];
          for (const row of compRows) {
            try {
              const data = JSON.parse(row.value);
              if (data.allComposers) {
                for (const comp of data.allComposers) {
                  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
                  if (comp.conversation) {
                    for (const msg of comp.conversation) {
                      const role = msg.type === 1 ? "user" : "assistant";
                      if (msg.text) messages.push({ role, content: msg.text });
                    }
                  }
                  if (messages.length > 0) {
                    memories.push({
                      tool: "cursor",
                      sessionId: comp.composerId || workspace,
                      timestamp: comp.createdAt ? new Date(comp.createdAt).toISOString() : new Date().toISOString(),
                      messages,
                    });
                  }
                }
              }
            } catch (e) {}
          }
          db.close();
        } catch (e) {}
      }
    } catch (e) {
      console.error("Error harvesting Cursor:", e);
    }

    return memories;
  }

  /**
   * Harvests memories from VS Code Copilot
   */
  async harvestVSCode(): Promise<MemoryEntry[]> {
    const memories: MemoryEntry[] = [];
    const vscodePath = this.getVSCodePath();
    const globalPath = this.getVSCodeGlobalPath();

    console.log(`Scanning VSCode path: ${vscodePath}`);
    console.log(`Scanning Global path: ${globalPath}`);

    const scanJsonlDir = async (dir: string) => {
      try {
        const files = await fs.readdir(dir).catch(() => []);
        for (const file of files) {
          if (file.endsWith(".jsonl")) {
            const content = await fs.readFile(join(dir, file), "utf-8");
            const lines = content.trim().split("\n");
            const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
            let timestamp = new Date().toISOString();
            
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                // Kind 2 often contains the message/response object
                if (entry.kind === 2 && entry.v?.message?.text) {
                  messages.push({ role: "user", content: entry.v.message.text });
                } else if (entry.kind === 1 && entry.k?.includes("inputText") && entry.v) {
                   // Some versions store input text as kind 1 updates
                   messages.push({ role: "user", content: entry.v });
                }
              } catch (e) {}
            }
            if (messages.length > 0) {
              memories.push({
                tool: "vscode",
                sessionId: file.replace(".jsonl", ""),
                timestamp,
                messages
              });
            }
          }
        }
      } catch (e) {}
    };

    // 1. Scan workspace storage for chatSessions
    try {
      const workspaces = await fs.readdir(vscodePath).catch(() => []);
      for (const workspace of workspaces) {
        const chatSessionsPath = join(vscodePath, workspace, "chatSessions");
        await scanJsonlDir(chatSessionsPath);
      }
    } catch (e) {}

    // 2. Scan global storage for emptyWindowChatSessions
    await scanJsonlDir(join(globalPath, "emptyWindowChatSessions"));

    return memories;
  }

  /**
   * Harvests memories from Windsurf (Codeium)
   * Note: Currently a stub as Windsurf uses encrypted Protobuf files
   */
  async harvestWindsurf(): Promise<MemoryEntry[]> {
    const memories: MemoryEntry[] = [];
    const windsurfPath = join(homedir(), '.codeium', 'windsurf', 'cascade');
    // For now, we just check if the directory exists to acknowledge it
    try {
      const stats = await fs.stat(windsurfPath).catch(() => null);
      if (stats) {
        // In the future, add Protobuf parsing here
      }
    } catch (e) {}
    return memories;
  }
}
