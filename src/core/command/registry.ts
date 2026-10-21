// The command registry. One registry is the single source of truth for every
// mutation the system supports — shared by the UI and by the MCP tool surface,
// so an agent and the app speak the exact same language.

import { CommandDef, JSONSchema } from "./types";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export class CommandRegistry {
  private defs = new Map<string, CommandDef<any>>();

  register<P>(def: CommandDef<P>): this {
    if (this.defs.has(def.type)) throw new Error(`Duplicate command type "${def.type}"`);
    this.defs.set(def.type, def as CommandDef<any>);
    return this;
  }

  get(type: string): CommandDef<any> | undefined {
    return this.defs.get(type);
  }

  list(): CommandDef<any>[] {
    return [...this.defs.values()];
  }

  /**
   * Export every command as an MCP tool. The tool name is the command type, the
   * description folds in the summary, long description, and worked examples so
   * an LLM has everything it needs to call it correctly.
   */
  toMcpTools(): McpTool[] {
    return this.list().map((def) => {
      const examples =
        def.examples && def.examples.length
          ? "\n\nExamples:\n" +
            def.examples
              .map((e) => `- ${e.note ? e.note + ": " : ""}${JSON.stringify(e.params)}`)
              .join("\n")
          : "";
      return {
        name: def.type,
        description: `${def.summary}\n\n${def.description}${examples}`,
        inputSchema: def.paramsSchema,
      };
    });
  }
}
