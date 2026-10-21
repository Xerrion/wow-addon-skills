import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  annotationRoots,
  checkRuntime,
  createMcpConfiguration,
  resolveDirectory,
  resolveRipgrep,
} from "../scripts/mcp-config.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "wow-mcp-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder =
    process.platform === "win32"
      ? "checkout [custom] with spaces"
      : 'checkout with "quotes" and spaces';
  const base = path.join(root, folder);
  const home = path.join(root, "home");
  mkdirSync(path.join(base, "scripts"), { recursive: true });
  mkdirSync(home);
  const helper = path.join(base, "scripts/mcp-config.mjs");
  cpSync(path.join(repository, "scripts/mcp-config.mjs"), helper);
  return {
    root,
    base,
    home,
    helper,
    build() {
      mkdirSync(path.join(base, "dist/mcp"), { recursive: true });
      writeFileSync(path.join(base, "dist/mcp/server.js"), "// fixture\n");
    },
    run(args = [], env = {}) {
      return spawnSync(process.execPath, [helper, ...args], {
        encoding: "utf8",
        cwd: tmpdir(),
        env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
      });
    },
  };
}

test("MCP JSON resolves runtime, checkout, data, and executable paths", (t) => {
  const f = fixture(t);
  f.build();
  const env = {
    WOW_ANNOTATIONS_ROOT: '~/API "catalog"',
    WOW_FRAMEXML_ROOT: "data/framexml",
    WOW_RG_COMMAND: process.execPath,
  };
  const result = f.run([], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    mcpServers: {
      "wow-addon": {
        command: process.execPath,
        args: [path.join(f.base, "dist/mcp/server.js")],
        env: {
          WOW_ANNOTATIONS_ROOT: path.join(f.home, 'API "catalog"'),
          WOW_FRAMEXML_ROOT: path.join(f.base, "data/framexml"),
          WOW_RG_COMMAND: process.execPath,
        },
      },
    },
  });
});

test("data paths expand home syntax and resolve relative to the checkout", () => {
  const base = path.resolve("fixture");
  const home = path.resolve("home");
  assert.equal(resolveDirectory("~", base, home), home);
  assert.equal(resolveDirectory("~/wow-api", base, home), path.join(home, "wow-api"));
  assert.equal(resolveDirectory("~\\wow-api", base, home), path.join(home, "wow-api"));
  assert.equal(
    resolveDirectory("annotations", base, home),
    path.join(base, "annotations"),
  );
  assert.throws(
    () => resolveDirectory("~someone/api", base, home),
    /Use an absolute path/,
  );
  assert.throws(() => resolveDirectory("one\ntwo", base, home), /line breaks/);
});

test("root query switches work before dependencies or a server build exist", (t) => {
  const f = fixture(t);
  const result = f.run(["--annotations-root"], { WOW_ANNOTATIONS_ROOT: "custom api" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(f.base, "custom api"));
  assert.equal(f.run(["--check-runtime"]).stdout, "");
  const preflight = f.run(["--check-prerequisites"], {
    WOW_RG_COMMAND: process.execPath,
  });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(preflight.stdout, "");
});

test("default data roots match the server's platform convention", () => {
  const home = path.resolve("fixture-home");
  const localData = path.resolve("local-app-data");
  const data =
    process.platform === "win32" ? localData : path.join(home, ".local/share");
  assert.deepEqual(annotationRoots({ LOCALAPPDATA: localData }, repository, home), {
    WOW_ANNOTATIONS_ROOT: path.join(data, "wow-annotations"),
    WOW_FRAMEXML_ROOT: path.join(data, "wow-framexml"),
  });
});

test("configuration errors print a remedy to stderr and no partial JSON", (t) => {
  const f = fixture(t);
  let result = f.run([], { WOW_RG_COMMAND: process.execPath });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Run bun run build and retry/);
  f.build();
  result = f.run([], { WOW_RG_COMMAND: path.join(f.root, "missing-rg") });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Install ripgrep or set WOW_RG_COMMAND/);
});

test("executable resolution searches PATH and rejects invalid commands", () => {
  const executable = path.basename(process.execPath);
  assert.equal(
    resolveRipgrep({
      PATH: path.dirname(process.execPath),
      WOW_RG_COMMAND: executable,
    }),
    process.execPath,
  );
  assert.throws(
    () => resolveRipgrep({ PATH: "", WOW_RG_COMMAND: "missing-rg" }),
    /Ripgrep executable not found/,
  );
  assert.throws(
    () => resolveRipgrep({ WOW_RG_COMMAND: "rg\nother" }),
    /one executable/,
  );
});

test("Bun runtime checks accept supported versions and reject older or missing versions", () => {
  for (const version of ["1.3.12", "1.3.13", "1.4.0", "2.0.0"]) checkRuntime(version);
  for (const version of ["0.1.0", "1.2.99", "1.3.11", "", "invalid"]) {
    assert.throws(() => checkRuntime(version), /Bun 1\.3\.12 or newer/);
  }
});

test("MCP generation preserves literal shell syntax in data directory names", (t) => {
  const f = fixture(t);
  f.build();
  const config = createMcpConfiguration({
    base: f.base,
    userHome: f.home,
    env: {
      WOW_RG_COMMAND: process.execPath,
      WOW_ANNOTATIONS_ROOT: "literal-$(nothing)-`unchanged`",
    },
  });
  assert.equal(
    config.mcpServers["wow-addon"].env.WOW_ANNOTATIONS_ROOT,
    path.join(f.base, "literal-$(nothing)-`unchanged`"),
  );
});

test("annotation maintenance help reports the configured paths without networking", {
  skip: process.platform === "win32",
}, () => {
  const result = spawnSync(
    "bash",
    [path.join(repository, "maintain-annotations.sh"), "--help"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        WOW_ANNOTATIONS_ROOT: "/custom/API files",
        WOW_FRAMEXML_ROOT: "/custom/FrameXML files",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("/custom/API files"));
  assert.ok(result.stdout.includes("/custom/FrameXML files"));
});
