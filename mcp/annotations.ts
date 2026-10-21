import { spawn } from "node:child_process";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataRoot } from "./tools/runtime.ts";

export const ANNOTATION_REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const FLAVORS = ["live", "classic", "classic_era", "classic_anniversary"];

export function runAnnotationMaintenance(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const windows = process.platform === "win32";
    const script = fileURLToPath(
      new URL(
        windows ? "../../maintain-annotations.ps1" : "../../maintain-annotations.sh",
        import.meta.url,
      ),
    );
    const child = spawn(
      windows ? "powershell.exe" : "bash",
      windows ? ["-NoProfile", "-NonInteractive", "-File", script] : [script],
      {
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        detached: !windows,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.pipe(process.stderr, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force = false) => {
      if (!child.pid) return;
      if (windows) {
        // taskkill includes Git descendants, which can outlive PowerShell.
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        }).on("error", () => child.kill());
      } else {
        try {
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill();
        }
      }
    };
    const abort = () => {
      kill();
      killTimer = setTimeout(() => kill(true), 5000);
      killTimer.unref();
    };
    const timeout = setTimeout(
      () => {
        timedOut = true;
        abort();
      },
      30 * 60 * 1000,
    );
    timeout.unref();
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (timedOut)
        reject(new Error("Annotation maintenance exceeded 30 minutes."));
      else if (code !== 0)
        reject(new Error(`Annotation maintenance exited with ${code ?? exitSignal}.`));
      else resolve();
    });
    if (signal.aborted) abort();
  });
}

export function createAnnotationMaintenance({
  env = process.env,
  run = runAnnotationMaintenance,
  now = Date.now,
  schedule = (callback: () => void, delay: number) => setTimeout(callback, delay),
  cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  log = (message: string) => console.error(`wow-addon-mcp: ${message}`),
} = {}) {
  const enabled = env.WOW_MCP_MANAGE_ANNOTATIONS ?? "true";
  if (!["true", "false"].includes(enabled)) {
    throw new Error("WOW_MCP_MANAGE_ANNOTATIONS must be true or false.");
  }
  const annotationsRoot =
    env.WOW_ANNOTATIONS_ROOT ??
    defaultDataRoot("wow-annotations", process.platform, env);
  const frameXmlRoot =
    env.WOW_FRAMEXML_ROOT ?? defaultDataRoot("wow-framexml", process.platform, env);
  if (!isAbsolute(annotationsRoot) || !isAbsolute(frameXmlRoot)) {
    throw new Error(
      "Annotation maintenance requires absolute WOW_ANNOTATIONS_ROOT and WOW_FRAMEXML_ROOT paths.",
    );
  }
  const statePath = `${frameXmlRoot}.update.json`;
  let ready = enabled === "false";
  let lastSuccess: number | null = null;
  let updateFailed = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let started = false;

  async function hasData() {
    const paths = [
      { path: join(annotationsRoot, "Annotations/Core/Data/Event.lua"), file: true },
      {
        path: join(
          annotationsRoot,
          "Annotations/Core/Blizzard_APIDocumentationGenerated",
        ),
        file: false,
      },
      ...FLAVORS.map((flavor) => ({
        path: join(frameXmlRoot, flavor, "Annotations"),
        file: false,
      })),
    ];
    const present = await Promise.all(
      paths.map(async ({ path, file }) => {
        try {
          const info = await stat(path);
          return file
            ? info.isFile() && info.size > 0
            : info.isDirectory() && (await readdir(path)).length > 0;
        } catch (error) {
          if (
            ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")
          )
            return false;
          throw error;
        }
      }),
    );
    return present.every(Boolean);
  }

  function queue(delay: number) {
    if (stopped) return;
    if (timer) cancel(timer);
    timer = schedule(() => {
      timer = undefined;
      void refresh();
    }, delay);
    timer.unref?.();
  }

  function refresh(): Promise<void> {
    if (stopped || enabled === "false") return Promise.resolve();
    if (pending) return pending;
    if (timer) {
      cancel(timer);
      timer = undefined;
    }
    controller = new AbortController();
    const signal = controller.signal;
    pending = (async () => {
      try {
        log("Refreshing API annotations and all FrameXML flavors.");
        await run(
          {
            ...env,
            WOW_ANNOTATIONS_ROOT: annotationsRoot,
            WOW_FRAMEXML_ROOT: frameXmlRoot,
          },
          signal,
        );
        signal.throwIfAborted();
        ready = await hasData();
        if (!ready)
          throw new Error(
            "Annotation maintenance finished without the required catalogs or FrameXML data.",
          );
        const timestamp = now();
        const temporary = `${statePath}.${process.pid}.tmp`;
        await writeFile(
          temporary,
          JSON.stringify({ annotationsRoot, frameXmlRoot, lastSuccess: timestamp }),
          { mode: 0o600 },
        );
        await rename(temporary, statePath);
        lastSuccess = timestamp;
        updateFailed = false;
        log("Annotations are ready. The next refresh is in 24 hours.");
      } catch (error) {
        if (stopped) return;
        updateFailed = true;
        ready = await hasData().catch(() => false);
        log(
          `Annotation refresh failed: ${error instanceof Error ? error.message : String(error)} ${ready ? "Continuing with local data." : "MCP is waiting for annotations."} Retrying in 1 hour.`,
        );
      } finally {
        pending = undefined;
        controller = undefined;
        queue(updateFailed ? RETRY_MS : ANNOTATION_REFRESH_MS);
      }
    })();
    return pending;
  }

  return {
    status: () => ({
      ready,
      updating: pending !== undefined,
      lastSuccess,
      updateFailed,
    }),
    refresh,
    async start() {
      if (started || stopped || enabled === "false") return;
      started = true;
      ready = await hasData();
      try {
        const previous = JSON.parse(await readFile(statePath, "utf8"));
        if (
          previous.annotationsRoot === annotationsRoot &&
          previous.frameXmlRoot === frameXmlRoot &&
          Number.isFinite(previous.lastSuccess) &&
          previous.lastSuccess > 0 &&
          previous.lastSuccess <= now()
        ) {
          lastSuccess = previous.lastSuccess;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          log("The saved annotation refresh time could not be read. Refreshing now.");
      }
      const remaining =
        lastSuccess === null ? 0 : ANNOTATION_REFRESH_MS - (now() - lastSuccess);
      if (!ready || remaining <= 0) void refresh();
      else queue(remaining);
    },
    async stop() {
      stopped = true;
      if (timer) {
        cancel(timer);
        timer = undefined;
      }
      controller?.abort(new Error("Annotation maintenance stopped."));
      await pending;
    },
  };
}

export type AnnotationStatus = ReturnType<
  ReturnType<typeof createAnnotationMaintenance>["status"]
>;
