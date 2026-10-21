// Stdio entry point for the Chisel CAD MCP server.
//
// Run with: npm run mcp   (builds to dist-mcp/ and launches over stdio)
// Point your MCP client at the built dist-mcp/server.mjs.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCadMcpServer } from "./server";

const { server } = createCadMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// stderr is safe for human-facing logs (stdout is the MCP protocol channel).
process.stderr.write("chisel-cad MCP server ready on stdio\n");
