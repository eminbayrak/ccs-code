import { join } from "path";
import { searchWiki, type SearchResult } from "./wikiSearch.js";
import type { LLMProvider } from "../llm/index.js";

function buildContext(results: SearchResult[]): string {
  return results
    .map((r, i) => [
      `--- Wiki Page ${i + 1}: "${r.title}" (type: ${r.type}) ---`,
      r.content.slice(0, 1500),
      "",
    ].join("\n"))
    .join("\n");
}

const SYSTEM_PROMPT = `You are an AI assistant with access to a personal knowledge base (wiki).

When answering questions:
1. ALWAYS prioritize information from the provided wiki pages over your training data.
2. Cite your sources using the format [[page-title]] when referencing a wiki page.
3. If the wiki pages don't contain enough information, say so clearly and note what's missing.
4. Be concise but complete.
5. At the end of your answer, add a "## Sources" section listing the wiki pages you used.`;

export type AskResult = {
  answer: string;
  sources: SearchResult[];
  wikiPageCount: number;
};

export async function askWiki(
  vaultPath: string,
  question: string,
  provider: LLMProvider,
  topK = 6,
): Promise<AskResult> {
  const wikiDir = join(vaultPath, "wiki");

  // Search wiki for relevant pages
  const sources = await searchWiki(wikiDir, question, topK);

  let answer: string;

  if (sources.length === 0) {
    // No wiki context — answer directly but note the gap
    answer = await provider.chat(
      [{ role: "user", content: question }],
      `${SYSTEM_PROMPT}\n\nNote: The wiki is empty or has no pages relevant to this question. Answer from your general knowledge but note that no wiki context was available.`,
    );
  } else {
    const context = buildContext(sources);
    const prompt = `Use the following wiki pages from my knowledge base to answer the question.

${context}

Question: ${question}`;

    answer = await provider.chat(
      [{ role: "user", content: prompt }],
      SYSTEM_PROMPT,
    );
  }

  return { answer, sources, wikiPageCount: sources.length };
}
