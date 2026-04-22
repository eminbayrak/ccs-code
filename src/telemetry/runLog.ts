export type RunLogEvent = {
    timestamp: number;
    type: "plan" | "tool_call" | "tool_result" | "response" | "error";
    payload: unknown;
};

export class RunLogger {
    private readonly events: RunLogEvent[] = [];

    add(event: Omit<RunLogEvent, "timestamp">): void {
        this.events.push({
            ...event,
            timestamp: Date.now(),
        });
    }

    getEvents(): RunLogEvent[] {
        return [...this.events];
    }
}
