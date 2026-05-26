#!/usr/bin/env node
/**
 * OpenGhost MCP server — boot entry point.
 *
 * This file is intentionally minimal. All logic lives in ./lib.js so it can
 * be imported by tests without side effects. This file ALWAYS boots the
 * server when executed.
 *
 * @license MIT
 * @author Ghostoli Production
 */

import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CONFIG, TOOLS, generateImage, editImage } from "./lib.js";

// Suppress noisy deprecation warnings from transitive deps so Claude Desktop
// developer logs stay readable.
process.removeAllListeners("warning");

// Diagnostic startup line on stderr (visible in Claude Desktop dev logs,
// does NOT corrupt the stdio MCP protocol which uses stdout).
console.error(
  `[openghost] starting v1.1.0 model=${CONFIG.model} quality=${CONFIG.defaultQuality} hasApiKey=${CONFIG.apiKey ? "yes" : "no"} autoOpen=${CONFIG.autoOpen ? "on" : "off"}`
);

// Best-effort: ensure output directory exists. If it fails (permissions,
// invalid path), the failure will surface on first generation, not boot.
try {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
} catch (err) {
  console.error(`[openghost] could not create output directory ${CONFIG.outputDir}:`, err.message);
}

// Build the MCP server
const server = new Server(
  { name: "openghost", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  switch (name) {
    case "generate_image":
      return await generateImage(args);
    case "edit_image":
      return await editImage(args);
    default:
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

// Connect over stdio. Any error here is fatal — log and exit non-zero so
// Claude Desktop can show a meaningful failure in dev logs.
try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[openghost] connected, awaiting requests");
} catch (err) {
  console.error("[openghost] FATAL during startup:", err);
  process.exit(1);
}
