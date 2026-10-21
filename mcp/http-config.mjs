import { httpClientConfiguration } from "./http.ts";

try {
  console.log(JSON.stringify(httpClientConfiguration(), null, 2));
} catch (error) {
  console.error(`MCP setup: ${error.message}`);
  process.exitCode = 1;
}
