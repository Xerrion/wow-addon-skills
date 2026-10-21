#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./index.ts";

const connection = serveStdio(createServer, {
  onerror: (error) => console.error(`wow-addon-mcp: ${error.message}`),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void connection.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}
