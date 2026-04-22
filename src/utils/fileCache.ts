import { promises as fs } from "fs";
import { join } from "path";

type CacheEntry = {
  mtimeMs: number;
  size: number;
};

export async function checkFileCacheCached(filePath: string): Promise<boolean> {
   const ccsDir = join(process.cwd(), ".ccs");
   const cachePath = join(ccsDir, "cache.json");

   try {
     const stats = await fs.stat(filePath);
     let cacheData: Record<string, CacheEntry> = {};
     
     try {
       const raw = await fs.readFile(cachePath, "utf-8");
       cacheData = JSON.parse(raw);
     } catch(e) {
       // Cache doesn't exist yet, proceeding as new
     }

     const existing = cacheData[filePath];
     // Use exact metadata match
     if (existing && existing.mtimeMs === stats.mtimeMs && existing.size === stats.size) {
       return true; // File matches securely, skip loading to LLM!
     }

     // Write active cache changes
     cacheData[filePath] = { mtimeMs: stats.mtimeMs, size: stats.size };
     await fs.mkdir(ccsDir, { recursive: true });
     await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2));
     
     return false; // Register new cache hit
   } catch(e) {
     return false; // File doesn't exist, ignore cache check entirely
   }
}
