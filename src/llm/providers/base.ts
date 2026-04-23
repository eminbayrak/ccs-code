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

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: "string" | "number" | "boolean";
    description: string;
    required?: boolean;
  }>;
};

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/**
 * The common interface every LLM provider must implement.
 * Adding a new provider means creating a new file in this folder
 * that satisfies this interface.
 */
export interface LLMProvider {
  name: string;
  chat(messages: Message[], systemPrompt?: string): Promise<string>;

  /**
   * Agentic tool-calling loop. The provider drives the loop internally:
   * send → model returns tool calls → caller executes them → repeat until done.
   * Optional — providers that don't implement it fall back to plain chat().
   */
  chatWithTools?(
    messages: Message[],
    tools: ToolDefinition[],
    executeToolCall: (call: ToolCall) => Promise<string>,
    systemPrompt?: string,
  ): Promise<string>;

  structuredPlan?(
    messages: Message[],
    systemPrompt: string,
  ): Promise<StructuredPlanResponse>;
}
