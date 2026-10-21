import { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { ToolOutput } from "./tools/runtime.ts";
import apiLookup from "./tools/wow-api-lookup.ts";
import blizzardSource from "./tools/wow-blizzard-source.ts";
import eventInfo from "./tools/wow-event-info.ts";
import wikiFetch from "./tools/wow-wiki-fetch.ts";

export function createServer() {
  const server = new McpServer({ name: "wow-addon", version: "1.0.0" });

  function register<Shape extends z.ZodRawShape>(
    name: string,
    tool: {
      description: string;
      inputSchema: z.ZodObject<Shape>;
      execute: (args: unknown) => Promise<ToolOutput>;
    },
    openWorldHint = false,
  ) {
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint,
        },
      },
      async (args) => {
        try {
          const result = await tool.execute(args);
          const structuredContent =
            typeof result === "string" ? { output: result } : result;
          return {
            content: [{ type: "text" as const, text: structuredContent.output }],
            structuredContent,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }
      },
    );
  }

  register("wow-api-lookup", apiLookup);
  register("wow-event-info", eventInfo);
  register("wow-blizzard-source", blizzardSource);
  register("wow-wiki-fetch", wikiFetch, true);
  return server;
}
