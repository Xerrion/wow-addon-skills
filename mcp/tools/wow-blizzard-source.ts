import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defaultDataRoot, defineTool, runCommand } from "./runtime.ts";

/**
 * wow-blizzard-source: ripgrep over the per-flavour FrameXML annotated
 * source tree at `<data root>/wow-framexml/<flavor>/Annotations/`, where the
 * data root is `~/.local/share` on macOS/Linux and `%LOCALAPPDATA%` on
 * Windows, returning matched lines with bounded context.
 *
 * Local search contract:
 *   - three args (`pattern`, `flavor`, `scope`)
 *   - `flavor` accepts `retail` as an alias for `live` (orchestrator amendment)
 *   - returns { output, metadata: { flavor, matchCount, selfTruncated } },
 *     where matchCount is the number of rendered match lines
 *   - 40 KB self-cap with explicit truncation tail
 *   - invalid input, missing flavor directories, and search failures throw; "no matches"
 *     returns a populated body with matchCount: 0
 *   - paths in output are anchor-relative (AddOns/Blizzard_X/...), never absolute
 */

export { defaultDataRoot } from "./runtime.ts";

const FRAMEXML_ROOT = process.env.WOW_FRAMEXML_ROOT ?? defaultDataRoot("wow-framexml");
const BUDGET = 40_000;
const MAX_PATTERN_LEN = 500;
const RG_CONTEXT = 3;
const RG_MAX_COUNT_PER_FILE = 5;
const RG_COMMAND = process.env.WOW_RG_COMMAND ?? "rg";

const FLAVOR_ENUM = [
  "live",
  "retail",
  "classic",
  "classic_anniversary",
  "classic_era",
] as const;
type FlavorArg = (typeof FLAVOR_ENUM)[number];
type ResolvedFlavor = "live" | "classic" | "classic_anniversary" | "classic_era";

const SCOPE_ENUM = ["lua", "xml", "all"] as const;
type Scope = (typeof SCOPE_ENUM)[number];

function resolveFlavor(f: FlavorArg): ResolvedFlavor {
  return f === "retail" ? "live" : f;
}

function globsFor(scope: Scope): string[] {
  if (scope === "lua") return ["-g", "*.lua.annotated.lua"];
  if (scope === "xml") return ["-g", "*.xml.annotated.lua"];
  // Multiple positive globs include both annotated Lua and XML sources.
  return ["-g", "*.lua.annotated.lua", "-g", "*.xml.annotated.lua"];
}

/** Fence wider than any backtick run in `content`, min 3. */
function fenceFor(content: string): string {
  let max = 0;
  const re = /`+/g;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    if (m[0].length > max) max = m[0].length;
  }
  return "`".repeat(Math.max(3, max + 1));
}

type RgLine = { path: string; line: number; text: string; isMatch: boolean };

/**
 * Strip an absolute prefix if rg ever emits one. With cwd set to
 * `Annotations/`, rg uses relative paths - but defence in depth, never
 * leak `/Users/...` to the caller. Also strip a leading `./`.
 */
function stripPathPrefix(p: string, absRoot: string): string {
  const withSlash = absRoot.endsWith("/") ? absRoot : `${absRoot}/`;
  if (p.startsWith(withSlash)) return p.slice(withSlash.length);
  if (p.startsWith("./")) return p.slice(2);
  return p;
}

/**
 * Parse a single rg line. Match lines use `path:line:text`; context lines
 * use `path-line-text`. Both forms must have the absolute prefix stripped
 * (the previous bug-class was leaking `/Users/...` on context lines).
 */
function parseRgLine(raw: string, absRoot: string): RgLine | null {
  // The lazy path capture selects the first valid line-number separator.
  const reMatch = /^(.+?):(\d+):(.*)$/;
  const reCtx = /^(.+?)-(\d+)-(.*)$/;
  let m = reMatch.exec(raw);
  if (m) {
    return {
      path: stripPathPrefix(m[1]!, absRoot),
      line: Number(m[2]!),
      text: m[3]!,
      isMatch: true,
    };
  }
  m = reCtx.exec(raw);
  if (m) {
    return {
      path: stripPathPrefix(m[1]!, absRoot),
      line: Number(m[2]!),
      text: m[3]!,
      isMatch: false,
    };
  }
  return null;
}

type FileGroup = {
  path: string;
  lines: RgLine[];
  matchCount: number;
};

/**
 * Group rg output into per-file blocks preserving rg's ordering. File
 * boundaries are explicit (path change); rg's `--` separators between
 * match groups inside the same file are preserved as gap markers so the
 * rendered block reads naturally.
 */
function groupByFile(lines: RgLine[]): FileGroup[] {
  const groups: FileGroup[] = [];
  let current: FileGroup | null = null;
  for (const l of lines) {
    if (current === null || current.path !== l.path) {
      current = { path: l.path, lines: [], matchCount: 0 };
      groups.push(current);
    }
    const isCountedMatch = l.isMatch && current.matchCount < RG_MAX_COUNT_PER_FILE;
    current.lines.push(isCountedMatch === l.isMatch ? l : { ...l, isMatch: false });
    if (isCountedMatch) current.matchCount += 1;
  }
  return groups;
}

/**
 * Render a single file block: header + fenced body. Body uses rg's
 * standard `123:` (match) / `123-` (context) gutter, and `--` separators
 * between non-contiguous chunks within the same file.
 */
function renderFileBlock(group: FileGroup): string {
  const bodyLines: string[] = [];
  let prev: RgLine | null = null;
  for (const l of group.lines) {
    if (prev !== null && l.line - prev.line > 1) {
      bodyLines.push("--");
    }
    const gutter = l.isMatch ? `${l.line}:` : `${l.line}-`;
    bodyLines.push(`${gutter}${l.text}`);
    prev = l;
  }
  const body = bodyLines.join("\n");
  const fence = fenceFor(body);
  return `## ${group.path}\n${fence}lua\n${body}\n${fence}\n\n`;
}

async function runRg(
  pattern: string,
  scope: Scope,
  absRoot: string,
): Promise<{ lines: RgLine[]; exitCode: number; stderr: string }> {
  const args = [
    "--color",
    "never",
    "--no-heading",
    "--line-number",
    "-C",
    String(RG_CONTEXT),
    "--max-count",
    String(RG_MAX_COUNT_PER_FILE),
    "--max-filesize",
    "5M",
    ...globsFor(scope),
    "-e",
    pattern,
    ".",
  ];

  let result: Awaited<ReturnType<typeof runCommand>>;
  try {
    result = await runCommand(RG_COMMAND, args, absRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`wow-blizzard-source: failed to launch rg: ${message}`);
  }
  const { stdout, stderr, exitCode } = result;
  const lines: RgLine[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw === "" || raw === "--") continue;
    const parsed = parseRgLine(raw, absRoot);
    if (parsed) lines.push(parsed);
  }
  if (exitCode === 0 && lines.length === 0) {
    throw new Error("wow-blizzard-source: rg returned unparseable output");
  }
  return { lines, exitCode, stderr };
}

function renderNoMatch(pattern: string, flavor: ResolvedFlavor, scope: Scope): string {
  const relRoot = `wow-framexml/${flavor}/Annotations/`;
  return [
    `# ${pattern} (flavor: ${flavor}, scope: ${scope})`,
    "",
    `No matches in ${relRoot} (scope: ${scope}).`,
    "",
    "Try a different flavor (live | classic | classic_anniversary | classic_era),",
    'broaden scope to "all", or check the pattern syntax (ripgrep regex).',
    "",
  ].join("\n");
}

export default defineTool({
  description:
    "Ripgrep over the per-flavor WoW FrameXML annotated source tree (wow-framexml/<flavor>/Annotations/ under the platform data root: ~/.local/share on macOS/Linux, %LOCALAPPDATA% on Windows). Returns matched lines with 3 lines of context, capped at 5 matches per file and 40 KB total. Scope filters by *.lua.annotated.lua, *.xml.annotated.lua, or both.",
  args: {
    pattern: z.string().min(1),
    flavor: z.enum(FLAVOR_ENUM).default("live"),
    scope: z.enum(SCOPE_ENUM).default("lua"),
  },
  async execute({ pattern, flavor, scope }) {
    const p = pattern.trim();
    if (p.length === 0) {
      throw new Error("wow-blizzard-source: pattern must be non-empty");
    }
    if (p.length > MAX_PATTERN_LEN) {
      throw new Error(
        `wow-blizzard-source: pattern exceeds ${MAX_PATTERN_LEN} characters`,
      );
    }
    if (/[\r\n]/.test(p)) {
      throw new Error("wow-blizzard-source: pattern must not contain newlines");
    }

    const resolved = resolveFlavor(flavor);
    const absRoot = join(FRAMEXML_ROOT, resolved, "Annotations");

    if (!existsSync(absRoot)) {
      throw new Error(
        `wow-blizzard-source: flavor '${resolved}' not available at ${absRoot}`,
      );
    }

    const { lines, exitCode, stderr } = await runRg(p, scope, absRoot);

    if (exitCode === 2) {
      throw new Error(
        `wow-blizzard-source: invalid regex: ${stderr.trim().slice(0, 200)}`,
      );
    }
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(
        `wow-blizzard-source: rg failed with exit code ${exitCode}: ${stderr.trim().slice(0, 200) || "no diagnostic output"}`,
      );
    }

    const groups = groupByFile(lines);
    const totalMatches = groups.reduce((sum, g) => sum + g.matchCount, 0);

    if (groups.length === 0 || totalMatches === 0) {
      return {
        output: renderNoMatch(p, resolved, scope),
        metadata: { flavor: resolved, matchCount: 0, selfTruncated: false },
      };
    }

    const header = `# ${p} (flavor: ${resolved}, scope: ${scope})\n\n`;
    const renderedBlocks: string[] = [];
    let used = Buffer.byteLength(header, "utf8");
    let filesRendered = 0;
    let matchesRendered = 0;
    let selfTruncated = false;

    for (const group of groups) {
      const block = renderFileBlock(group);
      const blockSize = Buffer.byteLength(block, "utf8");
      // Reserve ~300 bytes for the tail line / footer in case this is
      // the last block we can fit.
      if (used + blockSize > BUDGET - 300) {
        selfTruncated = true;
        break;
      }
      renderedBlocks.push(block);
      used += blockSize;
      filesRendered += 1;
      matchesRendered += group.matchCount;
    }

    let body = header + renderedBlocks.join("");

    if (selfTruncated) {
      const remainingFiles = groups.length - filesRendered;
      body += `... output truncated at 40 KB; at least ${remainingFiles} more file(s) have matches not shown. Counts are capped at ${RG_MAX_COUNT_PER_FILE} matches per file; narrow your pattern, or restrict scope to lua/xml only.\n`;
    } else {
      body += `---\nReported ${totalMatches} match(es) across ${groups.length} file(s), capped at ${RG_MAX_COUNT_PER_FILE} per file; files reaching the cap may contain more. Searched wow-framexml/${resolved}/Annotations/ (scope: ${scope}).\n`;
    }

    return {
      output: body,
      metadata: {
        flavor: resolved,
        matchCount: matchesRendered,
        selfTruncated,
      },
    };
  },
});
