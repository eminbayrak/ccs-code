import type { ToolDescriptor } from "../capabilities/types.js";

export type ConnectorContext = {
    cwd: string;
};

export interface ConnectorAdapter {
    name: string;
    getTools(context: ConnectorContext): ToolDescriptor[];
}
