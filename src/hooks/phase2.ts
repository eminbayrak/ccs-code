/**
 * Phase 2 features: Expression evaluation, hook history, debugging
 */

/**
 * Simple expression evaluator for hook matchers
 * Supports conditions like:
 * - `toolName === 'write_file'`
 * - `riskClass === 'write' || riskClass === 'dangerous'`
 * - `input.contains('secret')`
 */
export class ExpressionEvaluator {
    private cache: Map<string, Function> = new Map();

    /**
     * Evaluate a condition expression against context
     */
    evaluate(expression: string, context: any): boolean {
        try {
            const func = this.cache.get(expression) || this.compile(expression);
            return func(context);
        } catch (error) {
            console.warn(`Expression evaluation error: ${error}`);
            return false;
        }
    }

    /**
     * Compile and cache an expression
     */
    private compile(expression: string): Function {
        // Sanitize: only allow access to context properties
        // Create a function that accepts variables and returns boolean
        const sanitized = this.sanitizeExpression(expression);

        const func = new Function(
            "context",
            `
            const { toolName, toolInput, riskClass, event, sessionId } = context;
            try {
                return !!(${sanitized});
            } catch (e) {
                return false;
            }
        `,
        ) as (...args: any[]) => boolean;

        this.cache.set(expression, func);
        return func;
    }

    /**
     * Basic expression validation and sanitization
     */
    private sanitizeExpression(expression: string): string {
        // Block dangerous patterns
        const dangerous = [
            /require\s*\(/,
            /import\s+/,
            /eval\s*\(/,
            /Function\s*\(/,
            /process\./,
            /global\./,
            /__proto__/,
            /constructor/,
        ];

        for (const pattern of dangerous) {
            if (pattern.test(expression)) {
                throw new Error("Expression contains forbidden pattern");
            }
        }

        return expression;
    }

    clear(): void {
        this.cache.clear();
    }
}

/**
 * Hook execution history for debugging
 */
export type HookExecutionRecord = {
    id: string;
    hookId: string;
    event: string;
    timestamp: number;
    matched: boolean;
    duration: number;
    status: "success" | "failure" | "timeout";
    result?: any;
    error?: string;
};

export class HookHistoryTracker {
    private history: HookExecutionRecord[] = [];
    private maxSize: number;

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize;
    }

    record(record: HookExecutionRecord): void {
        this.history.push(record);
        // Keep history bounded
        if (this.history.length > this.maxSize) {
            this.history = this.history.slice(-this.maxSize);
        }
    }

    getHistory(hookId?: string, limit: number = 20): HookExecutionRecord[] {
        let results = this.history;
        if (hookId) {
            results = results.filter((r) => r.hookId === hookId);
        }
        return results.slice(-limit);
    }

    getStats(): {
        total: number;
        successful: number;
        failed: number;
        avgDuration: number;
    } {
        const total = this.history.length;
        const successful = this.history.filter((r) => r.status === "success").length;
        const failed = this.history.filter((r) => r.status === "failure").length;
        const avgDuration =
            total > 0
                ? this.history.reduce((sum, r) => sum + r.duration, 0) / total
                : 0;

        return {
            total,
            successful,
            failed,
            avgDuration,
        };
    }

    clear(): void {
        this.history = [];
    }
}
