import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const gitExecutable =
  process.platform === "win32"
    ? ""
    : spawnSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).stdout.trim();

function fixture(t, repositoryDirectory = "repo") {
  // Resolve macOS's /var alias so the test itself uses a physical path.
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "wow-addon-installers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const repo = path.join(root, repositoryDirectory);
  const bin = path.join(root, "bin");
  for (const directory of [home, repo, bin]) mkdirSync(directory, { recursive: true });
  for (const file of ["install.sh", "uninstall.sh", "maintain-annotations.sh"])
    cpSync(path.join(repository, file), path.join(repo, file));
  mkdirSync(path.join(repo, "scripts"));
  cpSync(
    path.join(repository, "scripts/mcp-config.mjs"),
    path.join(repo, "scripts/mcp-config.mjs"),
  );
  mkdirSync(path.join(repo, "skills"));
  cpSync(
    path.join(repository, "skills/wow-addon"),
    path.join(repo, "skills/wow-addon"),
    { recursive: true },
  );
  const unexpectedCommand = path.join(root, "unexpected-command");
  for (const command of ["opencode", "node", "npm", "bun", "git"]) {
    writeFileSync(
      path.join(bin, command),
      '#!/bin/sh\nprintf invoked > "$UNEXPECTED_COMMAND"\nexit 99\n',
      { mode: 0o755 },
    );
  }
  writeFileSync(path.join(bin, "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    root,
    home,
    repo,
    bin,
    skill: path.join(home, ".agents/skills/wow-addon"),
    unexpectedCommand,
    run(script, args = [], input = "", environment = {}) {
      const result = spawnSync("bash", [path.join(repo, script), ...args], {
        cwd: root,
        encoding: "utf8",
        input,
        timeout: 10000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local/share"),
          LOCALAPPDATA: path.join(home, "AppData/Local"),
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          UNEXPECTED_COMMAND: unexpectedCommand,
          ANNOTATION_LOG: path.join(root, "annotation-log"),
          BUN_LOG: path.join(root, "bun-log"),
          BUN_FAIL: "",
          REAL_BUN: process.execPath,
          REAL_GIT: gitExecutable,
          GIT_MUTATION_LOG: path.join(root, "git-mutation-log"),
          ...environment,
        },
      });
      assert.ifError(result.error);
      return result;
    },
  };
}

function succeeds(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function fails(result, message) {
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, message);
}

function put(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function contents(file) {
  return readFileSync(file, "utf8");
}

function mockMcp(f, { dependenciesPresent = false } = {}) {
  writeFileSync(
    path.join(f.bin, "bun"),
    `#!/bin/sh
case "$*" in
  ci|'run build') ;;
  *) exec "$REAL_BUN" "$@" ;;
esac
printf '%s\\n' "$*" >> "$BUN_LOG"
printf 'mock bun %s\\n' "$*"
if [ "$*" = ci ]; then
  [ "$BUN_FAIL" != ci ] || exit 21
  mkdir -p node_modules/@modelcontextprotocol/server node_modules/.bin
  touch node_modules/@modelcontextprotocol/server/package.json node_modules/.bin/tsc
elif [ "$*" = 'run build' ]; then
  [ "$BUN_FAIL" != build ] || exit 22
  mkdir -p dist/mcp
  printf 'rebuilt' > dist/mcp/server.js
else
  exit 23
fi
`,
    { mode: 0o755 },
  );
  if (dependenciesPresent) {
    put(
      path.join(f.repo, "node_modules/@modelcontextprotocol/server/package.json"),
      "{}",
    );
    put(path.join(f.repo, "node_modules/.bin/tsc"), "");
  }
}

function repositoryAt(f, directory, origin, { bare = false, branch } = {}) {
  const run = (args) => {
    const result = spawnSync(gitExecutable, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: path.join(f.root, "no-global-git-config"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    succeeds(result);
  };
  run(["init", "--quiet", ...(bare ? ["--bare"] : []), directory]);
  if (origin) run(["-C", directory, "config", "remote.origin.url", origin]);
  if (branch) run(["-C", directory, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
}

function readonlyGit(f) {
  writeFileSync(
    path.join(f.bin, "git"),
    `#!/bin/sh
if [ "$1" = -C ]; then
  case "$3" in
    config|rev-parse) exec "$REAL_GIT" "$@" ;;
    branch) [ "$4" != --show-current ] || exec "$REAL_GIT" "$@" ;;
  esac
fi
printf '%s\\n' "$*" >> "$GIT_MUTATION_LOG"
exit 98
`,
    { mode: 0o755 },
  );
}

describe("portable skill installers (Bash)", {
  skip: process.platform === "win32",
}, () => {
  test("installs without a client and preserves configuration, annotation data, and other skills", (t) => {
    const f = fixture(t);
    const otherSkill = path.join(f.home, ".agents/skills/other/SKILL.md");
    const clientConfig = path.join(f.home, ".config/other-client/config.json");
    const annotations = path.join(f.home, ".local/share/wow-annotations/keep");
    const framexml = path.join(f.home, ".local/share/wow-framexml/keep");
    for (const file of [otherSkill, clientConfig, annotations, framexml])
      put(file, "preserve");

    const result = f.run("install.sh");
    succeeds(result);
    assert.match(result.stdout, /Installed/);
    assert.match(result.stdout, /MCP server using README\.md/);
    assert.equal(
      contents(path.join(f.skill, "SKILL.md")),
      contents(path.join(f.repo, "skills/wow-addon/SKILL.md")),
    );
    assert.ok(existsSync(path.join(f.skill, "references/research-toolkit.md")));
    for (const file of [otherSkill, clientConfig, annotations, framexml])
      assert.equal(contents(file), "preserve");
    assert.equal(existsSync(path.join(f.home, ".config/opencode")), false);
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("skips an existing skill and force replaces only that skill directory", (t) => {
    const f = fixture(t);
    succeeds(f.run("install.sh"));
    put(path.join(f.skill, "SKILL.md"), "local edit");
    put(path.join(f.skill, "references/old.md"), "stale reference");
    const unrelated = path.join(f.home, ".agents/skills/unrelated/SKILL.md");
    put(unrelated, "keep");

    const skipped = f.run("install.sh");
    succeeds(skipped);
    assert.match(skipped.stdout, /Skipped/);
    assert.equal(contents(path.join(f.skill, "SKILL.md")), "local edit");

    succeeds(f.run("install.sh", ["--force"]));
    assert.equal(
      contents(path.join(f.skill, "SKILL.md")),
      contents(path.join(f.repo, "skills/wow-addon/SKILL.md")),
    );
    assert.equal(existsSync(path.join(f.skill, "references/old.md")), false);
    assert.equal(contents(unrelated), "keep");
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("supports an absolute custom destination containing spaces", (t) => {
    const f = fixture(t);
    const custom = path.join(f.root, "custom client", "skills");
    succeeds(f.run("install.sh", ["--skills-dir", `${custom}/`]));
    assert.ok(existsSync(path.join(custom, "wow-addon/SKILL.md")));
    assert.equal(existsSync(path.join(f.home, ".agents")), false);
    succeeds(f.run("uninstall.sh", ["--skills-dir", custom, "--yes"]));
    assert.equal(existsSync(path.join(custom, "wow-addon")), false);
    assert.ok(existsSync(custom));
  });

  test("uninstall requires confirmation and accepts an explicit affirmative response", (t) => {
    const f = fixture(t);
    succeeds(f.run("install.sh"));
    const declined = f.run("uninstall.sh", [], "n\n");
    succeeds(declined);
    assert.match(declined.stdout, /Aborted/);
    assert.ok(existsSync(f.skill));
    succeeds(f.run("uninstall.sh"));
    assert.ok(existsSync(f.skill), "EOF must not confirm removal");
    const confirmed = f.run("uninstall.sh", [], "yes\n");
    succeeds(confirmed);
    assert.match(confirmed.stdout, /Removed/);
    assert.equal(existsSync(f.skill), false);
  });

  test("explicit uninstall preserves sibling skills, annotations, and client configuration", (t) => {
    const f = fixture(t);
    succeeds(f.run("install.sh"));
    const preserved = [
      path.join(f.home, ".agents/skills/unrelated/SKILL.md"),
      path.join(f.home, ".local/share/wow-annotations/keep"),
      path.join(f.home, ".local/share/wow-framexml/keep"),
      path.join(f.home, ".config/client/config.json"),
    ];
    for (const file of preserved) put(file, "keep");
    succeeds(f.run("uninstall.sh", ["--yes"]));
    assert.equal(existsSync(f.skill), false);
    for (const file of preserved) assert.equal(contents(file), "keep");
    const absent = f.run("uninstall.sh", ["--yes"]);
    succeeds(absent);
    assert.match(absent.stdout, /Already absent/);
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("rejects root, home, and source-tree destinations before modification", (t) => {
    const f = fixture(t);
    for (const script of ["install.sh", "uninstall.sh"]) {
      const flag = script === "install.sh" ? "--force" : "--yes";
      for (const destination of ["/", f.home]) {
        fails(
          f.run(script, ["--skills-dir", destination, flag]),
          /dedicated skills directory/,
        );
      }
      fails(
        f.run(script, ["--skills-dir", path.join(f.repo, "skills"), flag]),
        /overlaps the source skill/,
      );
    }
    assert.ok(existsSync(path.join(f.repo, "skills/wow-addon/SKILL.md")));
    assert.equal(existsSync(path.join(f.home, ".agents")), false);
  });

  test("rejects destinations equal to or above the checkout without removing it", (t) => {
    for (const repositoryDirectory of ["wow-addon", "wow-addon/checkout"]) {
      const f = fixture(t, repositoryDirectory);
      const marker = path.join(f.repo, ".git/config");
      put(marker, "preserve checkout");
      for (const script of ["install.sh", "uninstall.sh"]) {
        const flag = script === "install.sh" ? "--force" : "--yes";
        fails(
          f.run(script, ["--skills-dir", f.root, flag]),
          /overlaps the source skill or repository/,
        );
        assert.equal(contents(marker), "preserve checkout");
        assert.ok(existsSync(path.join(f.repo, "skills/wow-addon/SKILL.md")));
        assert.ok(existsSync(path.join(f.repo, script)));
      }
    }
  });

  test("rejects case aliases of a destination containing the checkout", (t) => {
    for (const repositoryDirectory of ["wow-addon", "wow-addon/checkout"]) {
      const f = fixture(t, repositoryDirectory);
      const alias = f.root.toUpperCase();
      if (!existsSync(alias) || statSync(alias).ino !== statSync(f.root).ino) {
        t.skip("filesystem is case sensitive");
        return;
      }
      const marker = path.join(f.repo, ".git/config");
      put(marker, "preserve checkout");
      for (const script of ["install.sh", "uninstall.sh"]) {
        const flag = script === "install.sh" ? "--force" : "--yes";
        fails(
          f.run(script, ["--skills-dir", alias, flag]),
          /overlaps the source skill or repository/,
        );
        assert.equal(contents(marker), "preserve checkout");
        assert.ok(existsSync(path.join(f.repo, script)));
      }
    }
  });

  test("rejects destination links and linked ancestors without touching their targets", (t) => {
    const f = fixture(t);
    const outside = path.join(f.root, "outside");
    put(path.join(outside, "keep"), "keep");
    const skills = path.join(f.home, ".agents/skills");
    mkdirSync(skills, { recursive: true });
    symlinkSync(outside, f.skill, "dir");
    for (const script of ["install.sh", "uninstall.sh"]) {
      fails(
        f.run(script, [script === "install.sh" ? "--force" : "--yes"]),
        /symbolic link/i,
      );
    }
    rmSync(f.skill);
    const alias = path.join(f.root, "alias");
    symlinkSync(outside, alias, "dir");
    for (const script of ["install.sh", "uninstall.sh"]) {
      fails(
        f.run(script, [
          "--skills-dir",
          path.join(alias, "nested/skills"),
          script === "install.sh" ? "--force" : "--yes",
        ]),
        /symbolic link/i,
      );
    }
    assert.equal(contents(path.join(outside, "keep")), "keep");
    assert.equal(existsSync(path.join(outside, "nested")), false);
  });

  test("force rejects linked source content and retains the installed skill", (t) => {
    const f = fixture(t);
    succeeds(f.run("install.sh"));
    put(path.join(f.skill, "SKILL.md"), "keep installed copy");
    const outside = path.join(f.root, "outside");
    put(path.join(outside, "keep"), "keep");
    symlinkSync(outside, path.join(f.repo, "skills/wow-addon/linked"), "dir");
    fails(f.run("install.sh", ["--force"]), /Source skill contains symbolic links/);
    assert.equal(contents(path.join(f.skill, "SKILL.md")), "keep installed copy");
    assert.equal(contents(path.join(outside, "keep")), "keep");
  });

  test("validates flags and exposes help without creating directories", (t) => {
    const f = fixture(t);
    for (const script of ["install.sh", "uninstall.sh"]) {
      succeeds(f.run(script, ["--help"]));
      fails(f.run(script, ["--unknown"]), /Unknown option/);
      fails(f.run(script, ["--skills-dir"]), /requires an absolute directory path/);
      fails(f.run(script, ["--skills-dir", "relative/skills"]), /must be an absolute/);
      fails(
        f.run(script, ["--skills-dir", `${f.root}/not-created/../skills`]),
        /without \. or \.\./,
      );
    }
    assert.equal(existsSync(path.join(f.home, ".agents")), false);
  });

  test("runs annotation maintenance only when explicitly requested", (t) => {
    const f = fixture(t);
    writeFileSync(
      path.join(f.repo, "maintain-annotations.sh"),
      '#!/bin/sh\n[ "$1" != --check ] || exit 0\nprintf requested > "$ANNOTATION_LOG"\n',
    );
    succeeds(f.run("install.sh"));
    const log = path.join(f.root, "annotation-log");
    assert.equal(existsSync(log), false);
    succeeds(f.run("install.sh", ["--annotations"]));
    assert.equal(contents(log), "requested");
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("interactive setup can decline every optional action", (t) => {
    const f = fixture(t);
    const result = f.run("install.sh", ["--interactive"], "n\nn\nn\n");
    succeeds(result);
    assert.match(result.stderr, /Install the wow-addon skill/);
    assert.equal(existsSync(path.join(f.home, ".agents")), false);
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("interactive skill setup accepts a custom destination", (t) => {
    const f = fixture(t);
    const destination = path.join(f.root, "selected client", "skills");
    succeeds(f.run("install.sh", ["--interactive"], `y\n${destination}\nn\nn\n`));
    assert.ok(existsSync(path.join(destination, "wow-addon/SKILL.md")));
    assert.equal(existsSync(f.skill), false);
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("interactive replacement defaults to preserving the existing skill", (t) => {
    const f = fixture(t);
    succeeds(f.run("install.sh"));
    put(path.join(f.skill, "SKILL.md"), "local edit");
    const result = f.run("install.sh", ["--interactive", "--force"], "y\n\n\nn\nn\n");
    succeeds(result);
    assert.match(result.stderr, /Replace the existing skill.*\[y\/N\]/);
    assert.equal(contents(path.join(f.skill, "SKILL.md")), "local edit");
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("interactive replacement accepts confirmation", (t) => {
    const f = fixture(t);
    succeeds(f.run("install.sh"));
    put(path.join(f.skill, "SKILL.md"), "local edit");
    succeeds(f.run("install.sh", ["--interactive"], "y\n\ny\nn\nn\n"));
    assert.equal(
      contents(path.join(f.skill, "SKILL.md")),
      contents(path.join(f.repo, "skills/wow-addon/SKILL.md")),
    );
  });

  test("EOF at any setup prompt aborts before skill or MCP changes", (t) => {
    for (const input of ["", "y\n", "y\n\n", "y\n\nn\n", "n\ny\n\n"]) {
      const f = fixture(t);
      mockMcp(f);
      const result = f.run("install.sh", ["--interactive"], input);
      fails(result, /Input ended before setup was confirmed/);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(f.skill), false);
      assert.equal(existsSync(path.join(f.root, "bun-log")), false);
    }
  });

  test("non-interactive setup does not consume prompt answers", (t) => {
    const f = fixture(t);
    const result = f.run("install.sh", ["--non-interactive"], "n\nn\nn\n");
    succeeds(result);
    assert.ok(existsSync(f.skill));
    assert.equal(result.stderr, "");
    fails(f.run("install.sh", ["--interactive", "--non-interactive"]), /Choose either/);
  });

  test("MCP-only setup installs missing dependencies and prints only finished JSON", (t) => {
    const f = fixture(t, "repo with spaces");
    mockMcp(f);
    rmSync(path.join(f.repo, "skills"), { recursive: true });
    const clientSettings = path.join(f.home, ".config/client/settings.json");
    put(clientSettings, "keep settings");
    const result = f.run("install.sh", ["--mcp"]);
    succeeds(result);
    const config = JSON.parse(result.stdout).mcpServers["wow-addon"];
    assert.equal(config.command, process.execPath);
    assert.deepEqual(config.args, [path.join(f.repo, "dist/mcp/server.js")]);
    assert.equal(
      config.env.WOW_ANNOTATIONS_ROOT,
      path.join(f.home, ".local/share/wow-annotations"),
    );
    assert.equal(
      config.env.WOW_FRAMEXML_ROOT,
      path.join(f.home, ".local/share/wow-framexml"),
    );
    assert.ok(path.isAbsolute(config.env.WOW_RG_COMMAND));
    assert.equal(contents(path.join(f.root, "bun-log")), "ci\nrun build\n");
    assert.match(result.stderr, /mock bun ci/);
    assert.match(result.stderr, /mock bun run build/);
    assert.equal(existsSync(f.skill), false);
    assert.equal(contents(clientSettings), "keep settings");
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("MCP setup always rebuilds when locked dependencies already exist", (t) => {
    const f = fixture(t);
    mockMcp(f, { dependenciesPresent: true });
    put(path.join(f.repo, "dist/mcp/server.js"), "stale build");
    succeeds(f.run("install.sh", ["--non-interactive", "--mcp"]));
    assert.equal(contents(path.join(f.root, "bun-log")), "run build\n");
    assert.equal(contents(path.join(f.repo, "dist/mcp/server.js")), "rebuilt");
  });

  test("MCP setup repairs missing TypeScript even when the SDK exists", (t) => {
    const f = fixture(t);
    mockMcp(f, { dependenciesPresent: true });
    rmSync(path.join(f.repo, "node_modules/.bin/tsc"));
    succeeds(f.run("install.sh", ["--mcp"]));
    assert.equal(contents(path.join(f.root, "bun-log")), "ci\nrun build\n");
  });

  test("interactive defaults prepare both the skill and MCP without annotation maintenance", (t) => {
    const f = fixture(t);
    mockMcp(f);
    const result = f.run("install.sh", ["--interactive"], "\n\n\n\n\n\n");
    succeeds(result);
    assert.ok(JSON.parse(result.stdout).mcpServers["wow-addon"]);
    assert.ok(existsSync(f.skill));
    assert.equal(existsSync(path.join(f.root, "annotation-log")), false);
    assert.match(result.stderr, /Installed/);
  });

  test("interactive MCP setup preserves quoted paths and passes normalized roots to maintenance", (t) => {
    const f = fixture(t);
    mockMcp(f);
    const annotationInput = './data/annotations "quoted"';
    const framexmlInput = "~/FrameXML's data";
    writeFileSync(
      path.join(f.repo, "maintain-annotations.sh"),
      '#!/bin/sh\n[ "$1" != --check ] || exit 0\nprintf \'%s\\n%s\\n\' "$WOW_ANNOTATIONS_ROOT" "$WOW_FRAMEXML_ROOT" > "$ANNOTATION_LOG"\nprintf maintenance-log\\n\n',
    );
    const result = f.run(
      "install.sh",
      ["--interactive"],
      `n\ny\n${annotationInput}\n${framexmlInput}\ny\n`,
    );
    succeeds(result);
    const roots = JSON.parse(result.stdout).mcpServers["wow-addon"].env;
    assert.equal(roots.WOW_ANNOTATIONS_ROOT, path.resolve(f.repo, annotationInput));
    assert.equal(roots.WOW_FRAMEXML_ROOT, path.join(f.home, "FrameXML's data"));
    assert.equal(
      contents(path.join(f.root, "annotation-log")),
      `${roots.WOW_ANNOTATIONS_ROOT}\n${roots.WOW_FRAMEXML_ROOT}\n`,
    );
    assert.match(result.stderr, /maintenance-log/);
    assert.equal(existsSync(f.skill), false);
  });

  test("MCP setup honors environment paths without shell expansion", (t) => {
    const f = fixture(t);
    mockMcp(f);
    const annotations = path.join(f.root, 'annotations $(do-not-run) "quoted"');
    const framexml = path.join(f.root, "FrameXML's files");
    const ripgrep = path.join(f.bin, "ripgrep custom");
    writeFileSync(ripgrep, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = f.run("install.sh", ["--mcp"], "", {
      WOW_ANNOTATIONS_ROOT: annotations,
      WOW_FRAMEXML_ROOT: framexml,
      WOW_RG_COMMAND: ripgrep,
    });
    succeeds(result);
    assert.deepEqual(JSON.parse(result.stdout).mcpServers["wow-addon"].env, {
      WOW_ANNOTATIONS_ROOT: annotations,
      WOW_FRAMEXML_ROOT: framexml,
      WOW_RG_COMMAND: ripgrep,
    });
  });

  test("MCP setup reports runtime failure before dependency or skill changes", (t) => {
    const f = fixture(t);
    mockMcp(f);
    writeFileSync(
      path.join(f.bin, "bun"),
      "#!/bin/sh\nprintf 'old Bun runtime\\n' >&2\nexit 24\n",
      { mode: 0o755 },
    );
    const result = f.run("install.sh", ["--interactive"], "\n\n\n\n\n\n");
    fails(result, /Bun 1\.3\.12 or newer is required/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(path.join(f.root, "bun-log")), false);
    assert.equal(existsSync(f.skill), false);
  });

  test("MCP setup reports missing Bun before mutations", (t) => {
    const f = fixture(t);
    symlinkSync("/bin/bash", path.join(f.bin, "bash"));
    symlinkSync("/usr/bin/dirname", path.join(f.bin, "dirname"));
    rmSync(path.join(f.bin, "bun"));
    const result = f.run("install.sh", ["--mcp"], "", { PATH: f.bin });
    fails(result, /Bun is missing/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(f.skill), false);
    assert.equal(existsSync(f.unexpectedCommand), false);
  });

  test("MCP setup reports missing ripgrep before dependency or skill changes", (t) => {
    const f = fixture(t);
    mockMcp(f);
    const result = f.run("install.sh", ["--mcp"], "", {
      WOW_RG_COMMAND: "missing-wow-addon-ripgrep",
    });
    fails(result, /Ripgrep executable not found/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(path.join(f.root, "bun-log")), false);
    assert.equal(existsSync(f.skill), false);
  });

  test("annotation destination checks finish before dependency or skill changes", (t) => {
    for (const sourceRoot of [true, false]) {
      const f = fixture(t);
      mockMcp(f);
      const annotationRoot = sourceRoot ? f.repo : path.join(f.root, "unrelated");
      repositoryAt(f, annotationRoot, "https://github.com/example/unrelated.git");
      readonlyGit(f);
      const result = f.run(
        "install.sh",
        ["--interactive"],
        `\n\n\n${annotationRoot}\n\ny\n`,
      );
      fails(result, sourceRoot ? /overlaps the source checkout/ : /Unexpected origin/);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(path.join(f.root, "bun-log")), false);
      assert.equal(existsSync(f.skill), false);
      assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
    }
  });

  test("dependency and build failures never print MCP JSON", (t) => {
    for (const failure of ["ci", "build"]) {
      const f = fixture(t);
      mockMcp(f);
      const result = f.run("install.sh", ["--mcp"], "", { BUN_FAIL: failure });
      fails(
        result,
        failure === "ci" ? /Dependency installation failed/ : /MCP build failed/,
      );
      assert.equal(result.stdout, "");
      assert.equal(existsSync(f.skill), false);
    }
  });

  test("annotation maintenance failure prevents printing MCP JSON", (t) => {
    const f = fixture(t);
    mockMcp(f);
    writeFileSync(
      path.join(f.repo, "maintain-annotations.sh"),
      '#!/bin/sh\n[ "$1" != --check ] || exit 0\nexit 25\n',
    );
    const result = f.run("install.sh", ["--mcp", "--annotations"]);
    fails(result, /Annotation maintenance failed/);
    assert.equal(result.stdout, "");
  });
});

describe("annotation maintenance preflight (Bash)", {
  skip: process.platform === "win32",
}, () => {
  function roots(f) {
    return {
      WOW_ANNOTATIONS_ROOT: path.join(f.root, "annotations"),
      WOW_FRAMEXML_ROOT: path.join(f.root, "framexml"),
    };
  }

  function safeRepositories(f, env) {
    repositoryAt(
      f,
      env.WOW_ANNOTATIONS_ROOT,
      "https://github.com/Ketho/vscode-wow-api",
    );
    repositoryAt(
      f,
      path.join(env.WOW_FRAMEXML_ROOT, ".bare"),
      "https://github.com/NumyAddon/FramexmlAnnotations.git",
      { bare: true },
    );
  }

  test("checks missing and empty dedicated roots without creating or downloading anything", (t) => {
    const f = fixture(t);
    readonlyGit(f);
    const env = roots(f);
    for (const mode of ["missing", "empty"]) {
      if (mode === "empty") {
        for (const directory of Object.values(env)) mkdirSync(directory);
      }
      const result = f.run("maintain-annotations.sh", ["--check"], "", env);
      succeeds(result);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
      assert.equal(existsSync(path.join(env.WOW_FRAMEXML_ROOT, ".bare")), false);
      if (mode === "missing") {
        for (const directory of Object.values(env))
          assert.equal(existsSync(directory), false);
      }
    }
  });

  test("preflight supports the system Bash with default and selected flavors", (t) => {
    const f = fixture(t);
    readonlyGit(f);
    symlinkSync("/bin/bash", path.join(f.bin, "bash"));
    for (const args of [["--check"], ["--check", "--flavor", "classic_era"]]) {
      succeeds(f.run("maintain-annotations.sh", args, "", roots(f)));
    }
    assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
  });

  test("accepts expected HTTPS and SSH origins with supported worktree branches", (t) => {
    for (const [ketho, framexml] of [
      [
        "https://github.com/Ketho/vscode-wow-api.git",
        "git@github.com:NumyAddon/FramexmlAnnotations.git",
      ],
      [
        "git@github.com:Ketho/vscode-wow-api",
        "ssh://git@github.com/NumyAddon/FramexmlAnnotations",
      ],
      [
        "ssh://git@github.com:22/KETHO/VSCODE-WOW-API.GIT",
        "https://github.com/NUMYADDON/FRAMEXMLANNOTATIONS.GIT",
      ],
    ]) {
      const f = fixture(t);
      const env = roots(f);
      repositoryAt(f, env.WOW_ANNOTATIONS_ROOT, ketho);
      repositoryAt(f, path.join(env.WOW_FRAMEXML_ROOT, ".bare"), framexml, {
        bare: true,
      });
      repositoryAt(f, path.join(env.WOW_FRAMEXML_ROOT, "live"), framexml, {
        branch: "live-mix-into-source",
      });
      const metadata = path.join(env.WOW_FRAMEXML_ROOT, ".DS_Store");
      put(metadata, "preserve Finder metadata");
      readonlyGit(f);
      succeeds(
        f.run("maintain-annotations.sh", ["--check-only", "--flavor", "live"], "", env),
      );
      assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
      assert.equal(contents(metadata), "preserve Finder metadata");
    }
  });

  test("rejects an unrelated Ketho origin before any pull or clone", (t) => {
    const f = fixture(t);
    const env = roots(f);
    repositoryAt(
      f,
      env.WOW_ANNOTATIONS_ROOT,
      "https://github.com/example/unrelated.git",
    );
    readonlyGit(f);
    const config = path.join(env.WOW_ANNOTATIONS_ROOT, ".git/config");
    const original = contents(config);
    fails(f.run("maintain-annotations.sh", [], "", env), /Unexpected origin/);
    assert.equal(contents(config), original);
    assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
    assert.equal(existsSync(env.WOW_FRAMEXML_ROOT), false);
  });

  test("accepts a Ketho checkout whose .git entry is a worktree file", (t) => {
    const f = fixture(t);
    const env = roots(f);
    const original = path.join(f.root, "ketho-original");
    repositoryAt(f, original, "https://github.com/Ketho/vscode-wow-api");
    succeeds(
      spawnSync(
        gitExecutable,
        [
          "-C",
          original,
          "-c",
          "user.name=Installer Test",
          "-c",
          "user.email=installer@example.invalid",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "fixture",
        ],
        { encoding: "utf8" },
      ),
    );
    succeeds(
      spawnSync(
        gitExecutable,
        [
          "-C",
          original,
          "worktree",
          "add",
          "--quiet",
          "-b",
          "annotations",
          env.WOW_ANNOTATIONS_ROOT,
        ],
        { encoding: "utf8" },
      ),
    );
    assert.ok(statSync(path.join(env.WOW_ANNOTATIONS_ROOT, ".git")).isFile());
    readonlyGit(f);
    succeeds(f.run("maintain-annotations.sh", ["--check"], "", env));
    assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
  });

  test("checks the FrameXML origin before updating the valid Ketho repository", (t) => {
    const f = fixture(t);
    const env = roots(f);
    safeRepositories(f, env);
    const bare = path.join(env.WOW_FRAMEXML_ROOT, ".bare");
    const changed = spawnSync(
      gitExecutable,
      [
        "-C",
        bare,
        "config",
        "remote.origin.url",
        "git@github.com:example/unrelated.git",
      ],
      { encoding: "utf8" },
    );
    succeeds(changed);
    readonlyGit(f);
    fails(f.run("maintain-annotations.sh", [], "", env), /Unexpected origin/);
    assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
  });

  test("checks every requested worktree origin and branch before any updates", (t) => {
    for (const wrong of ["origin", "branch"]) {
      const f = fixture(t);
      const env = roots(f);
      safeRepositories(f, env);
      repositoryAt(
        f,
        path.join(env.WOW_FRAMEXML_ROOT, "classic"),
        wrong === "origin"
          ? "https://github.com/example/unrelated"
          : "https://github.com/NumyAddon/FramexmlAnnotations",
        { branch: wrong === "branch" ? "local-work" : "classic-mix-into-source" },
      );
      readonlyGit(f);
      fails(
        f.run("maintain-annotations.sh", [], "", env),
        wrong === "origin" ? /Unexpected origin/ : /expected 'classic-mix-into-source'/,
      );
      assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
    }
  });

  test("rejects nonempty unrelated data directories without changing their contents", (t) => {
    for (const root of ["WOW_ANNOTATIONS_ROOT", "WOW_FRAMEXML_ROOT"]) {
      const f = fixture(t);
      const env = roots(f);
      put(path.join(env[root], "keep.txt"), "preserve");
      readonlyGit(f);
      fails(
        f.run("maintain-annotations.sh", [], "", env),
        /not an expected checkout|contains unrelated files/,
      );
      assert.equal(contents(path.join(env[root], "keep.txt")), "preserve");
      assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
    }
  });

  test("rejects root, home, source checkout, overlapping roots, and symlink aliases", (t) => {
    const f = fixture(t);
    readonlyGit(f);
    const normal = roots(f);
    const alias = path.join(f.root, "annotation-alias");
    symlinkSync(f.repo, alias, "dir");
    for (const [annotation, framexml] of [
      ["/", normal.WOW_FRAMEXML_ROOT],
      [f.home, normal.WOW_FRAMEXML_ROOT],
      [f.repo, normal.WOW_FRAMEXML_ROOT],
      [path.join(f.repo, "data"), normal.WOW_FRAMEXML_ROOT],
      [normal.WOW_ANNOTATIONS_ROOT, normal.WOW_ANNOTATIONS_ROOT],
      [normal.WOW_ANNOTATIONS_ROOT, path.join(normal.WOW_ANNOTATIONS_ROOT, "nested")],
      [alias, normal.WOW_FRAMEXML_ROOT],
    ]) {
      fails(
        f.run("maintain-annotations.sh", ["--check"], "", {
          WOW_ANNOTATIONS_ROOT: annotation,
          WOW_FRAMEXML_ROOT: framexml,
        }),
        /dedicated annotation directory|overlaps the source checkout|data roots overlap|symbolic links/,
      );
    }
    assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
    assert.equal(existsSync(normal.WOW_ANNOTATIONS_ROOT), false);
  });

  test("rejects relative data roots before creating nested worktree destinations", (t) => {
    for (const root of ["WOW_ANNOTATIONS_ROOT", "WOW_FRAMEXML_ROOT"]) {
      const f = fixture(t);
      const env = { ...roots(f), [root]: "data/annotations" };
      readonlyGit(f);
      fails(
        f.run("maintain-annotations.sh", [], "", env),
        /must be absolute directory paths/,
      );
      assert.equal(existsSync(path.join(f.root, "data")), false);
      assert.equal(existsSync(path.join(f.root, "git-mutation-log")), false);
    }
  });

  test("missing Git fails before any directory or skill changes", (t) => {
    const f = fixture(t);
    rmSync(path.join(f.bin, "git"));
    symlinkSync("/bin/bash", path.join(f.bin, "bash"));
    symlinkSync("/usr/bin/dirname", path.join(f.bin, "dirname"));
    symlinkSync("/usr/bin/find", path.join(f.bin, "find"));
    const result = f.run("install.sh", ["--annotations"], "", { PATH: f.bin });
    fails(result, /Git is missing/);
    assert.equal(existsSync(f.skill), false);
    assert.equal(existsSync(path.join(f.home, ".local")), false);
  });
});
