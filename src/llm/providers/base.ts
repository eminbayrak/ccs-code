export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type StructuredPlanResponse = {
  plan: {
    goal: string;
    steps: Array<{
      type: "direct_answer" | "tool_call";
      toolName?: string;
      input?: Record<string, unknown>;
      reason: string;
    }>;
  };
};

/**
 * The common interface every LLM provider must implement.
 * Adding a new provider means creating a new file in this folder
 * that satisfies this interface.
 */
export interface LLMProvider {
  name: string;
  chat(messages: Message[], systemPrompt?: string): Promise<string>;
  structuredPlan?(
    messages: Message[],
    systemPrompt: string,
  ): Promise<StructuredPlanResponse>;
}
