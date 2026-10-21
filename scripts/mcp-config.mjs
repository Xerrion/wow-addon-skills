import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export function checkRuntime(version = process.versions.bun) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || "");
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  if (
    !match ||
    major < 1 ||
    (major === 1 && (minor < 3 || (minor === 3 && patch < 12)))
  ) {
    throw new Error(
      `Bun 1.3.12 or newer is required; found ${version || "a different runtime"}. Select a supported Bun executable and retry.`,
    );
  }
}

export function resolveDirectory(value, base = repositoryRoot, userHome = homedir()) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(
      "Annotation directory paths must not contain line breaks or null characters.",
    );
  }
  if (value === "~") return path.resolve(userHome);
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(userHome, value.slice(2));
  }
  if (value.startsWith("~")) {
    throw new Error(
      "Use an absolute path, a relative path, or ~/ for your home directory.",
    );
  }
  return path.resolve(base, value);
}

export function annotationRoots(
  env = process.env,
  base = repositoryRoot,
  userHome = homedir(),
) {
  const dataRoot =
    process.platform === "win32"
      ? env.LOCALAPPDATA || path.join(userHome, "AppData", "Local")
      : path.join(userHome, ".local", "share");
  return {
    WOW_ANNOTATIONS_ROOT: resolveDirectory(
      env.WOW_ANNOTATIONS_ROOT || path.join(dataRoot, "wow-annotations"),
      base,
      userHome,
    ),
    WOW_FRAMEXML_ROOT: resolveDirectory(
      env.WOW_FRAMEXML_ROOT || path.join(dataRoot, "wow-framexml"),
      base,
      userHome,
    ),
  };
}

export function resolveRipgrep(env = process.env, base = repositoryRoot) {
  const command = env.WOW_RG_COMMAND || "rg";
  if (/[\r\n\0]/.test(command))
    throw new Error("WOW_RG_COMMAND must name one executable.");
  const hasDirectory =
    path.isAbsolute(command) ||
    command.includes("/") ||
    (process.platform === "win32" && command.includes("\\"));
  const candidates = hasDirectory
    ? [path.resolve(base, command)]
    : (env.PATH || env.Path || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, command));
  const extensions = process.platform === "win32" ? ["", ".exe", ".com"] : [""];
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const executable = candidate + extension;
      try {
        accessSync(
          executable,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        if (statSync(executable).isFile()) return realpathSync(executable);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
      }
    }
  }
  throw new Error(
    `Ripgrep executable not found: ${command}. Install ripgrep or set WOW_RG_COMMAND to its executable path.`,
  );
}

export function createMcpConfiguration({
  env = process.env,
  base = repositoryRoot,
  bun = process.execPath,
  userHome = homedir(),
} = {}) {
  const server = path.resolve(base, "dist", "mcp", "server.js");
  if (!statSync(server, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `Built MCP server not found: ${server}. Run bun run build and retry.`,
    );
  }
  return {
    mcpServers: {
      "wow-addon": {
        command: path.resolve(bun),
        args: [server],
        env: {
          ...annotationRoots(env, base, userHome),
          WOW_RG_COMMAND: resolveRipgrep(env, base),
        },
      },
    },
  };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    checkRuntime();
    switch (process.argv[2]) {
      case "--check-runtime":
        break;
      case "--check-prerequisites":
        annotationRoots();
        resolveRipgrep();
        break;
      case "--annotations-root":
        console.log(annotationRoots().WOW_ANNOTATIONS_ROOT);
        break;
      case "--framexml-root":
        console.log(annotationRoots().WOW_FRAMEXML_ROOT);
        break;
      case undefined:
        console.log(JSON.stringify(createMcpConfiguration(), null, 2));
        break;
      default:
        throw new Error(`Unknown MCP configuration option: ${process.argv[2]}`);
    }
  } catch (error) {
    console.error(`MCP setup: ${error.message}`);
    process.exitCode = 1;
  }
}
