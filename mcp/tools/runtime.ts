import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export function defaultDataRoot(
  dirName: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, dirName);
  }
  return join(homedir(), ".local", "share", dirName);
}

export type ToolOutput =
  | string
  | {
      output: string;
      metadata: Record<string, unknown>;
    };

/** Keep validation and defaults consistent for MCP and direct local callers. */
export function defineTool<
  Shape extends z.ZodRawShape,
  Output extends ToolOutput,
>(definition: {
  description: string;
  args: Shape;
  execute: (args: z.output<z.ZodObject<Shape>>) => Promise<Output>;
}) {
  const inputSchema = z.strictObject(definition.args);
  return {
    description: definition.description,
    inputSchema,
    execute: (args: unknown) => definition.execute(inputSchema.parse(args)),
  };
}

/** Run without a shell and drain both pipes, including unsuccessful searches. */
export async function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      execFile(
        command,
        args,
        {
          cwd,
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error && (typeof error.code !== "number" || error.killed)) {
            reject(error);
            return;
          }
          const exitCode = error && typeof error.code === "number" ? error.code : 0;
          resolve({ stdout, stderr, exitCode });
        },
      );
    },
  );
}
