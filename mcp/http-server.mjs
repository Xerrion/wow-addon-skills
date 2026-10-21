#!/usr/bin/env bun
import { createAnnotationMaintenance } from "./annotations.ts";
import { createHttpApplication, httpConfiguration } from "./http.ts";

try {
  const configuration = httpConfiguration();
  const annotations = createAnnotationMaintenance();
  const application = createHttpApplication(configuration, annotations.status);
  const listener = Bun.serve({
    hostname: configuration.hostname,
    port: configuration.port,
    idleTimeout: 60,
    maxRequestBodySize: 1024 * 1024,
    fetch: application.fetch,
    error(error) {
      console.error(`wow-addon-mcp: ${error.message}`);
      return Response.json({ error: "Internal server error." }, { status: 500 });
    },
  });
  console.error(
    `wow-addon-mcp: Streamable HTTP listening on ${listener.url.origin}/mcp`,
  );

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      if (stopping) return;
      stopping = true;
      try {
        await Promise.all([
          annotations.stop(),
          application.close(),
          listener.stop(true),
        ]);
      } catch (error) {
        console.error(`wow-addon-mcp: ${error.message}`);
        process.exitCode = 1;
      }
    });
  }
  try {
    await annotations.start();
  } catch (error) {
    await Promise.all([annotations.stop(), application.close(), listener.stop(true)]);
    throw error;
  }
} catch (error) {
  console.error(`wow-addon-mcp: ${error.message}`);
  process.exitCode = 1;
}
