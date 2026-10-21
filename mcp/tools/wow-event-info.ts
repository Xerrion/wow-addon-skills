import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultDataRoot, defineTool } from "./runtime.ts";

/**
 * wow-event-info: exact-match lookup of a single WoW frame event in
 * `Annotations/Core/Data/Event.lua`, returning the payload signature plus a
 * same-prefix family window for orientation.
 *
 * Local lookup contract:
 *  - one arg (`event`), no mode/category/wiki flags
 *  - bare-string return
 *  - 40 KB self-cap
 *  - invalid input and unreadable or corrupt catalogs throw;
 *    "event not found" returns a string body
 *  - paths in output are anchor-relative (Annotations/Core/...), never absolute
 */

const REL_PATH = "Annotations/Core/Data/Event.lua";

export { defaultDataRoot } from "./runtime.ts";

const ABS_PATH = join(
  process.env.WOW_ANNOTATIONS_ROOT ?? defaultDataRoot("wow-annotations"),
  REL_PATH,
);
const BUDGET = 40_000;
const FAMILY_LINE_CAP = 30;
const SUGGESTION_CAP = 20;

// Matches lines of the shape `---|"EVENT_NAME"` or
// `---|"EVENT_NAME" # `payload``. Captures (1) name, (2) payload-without-#.
const LINE_RE = /^---\|"([A-Z0-9_]+)"(?:\s*#\s*(.*))?$/;

type Row = {
  lineNo: number;
  name: string;
  payload: string | null;
  raw: string;
};

function familyPrefix(name: string): string {
  const i = name.indexOf("_");
  return i === -1 ? name : name.slice(0, i);
}

/** Pick a fence delimiter longer than any backtick run in `content`. */
function fenceFor(content: string): string {
  let max = 0;
  const re = /`+/g;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    if (m[0].length > max) max = m[0].length;
  }
  return "`".repeat(Math.max(3, max + 1));
}

function parseRows(raw: string): Row[] {
  const lines = raw.split("\n");
  const rows: Row[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]!);
    if (m) {
      rows.push({
        lineNo: i + 1,
        name: m[1]!,
        payload: m[2] ?? null,
        raw: lines[i]!,
      });
    } else if (lines[i]?.startsWith('---|"')) {
      throw new Error(`malformed event row at line ${i + 1}`);
    }
  }
  if (rows.length === 0) {
    throw new Error("catalog contains no event rows");
  }
  return rows;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Render a single family-window entry. Mark the matched event with a trailing
 * comment so the caller can locate it inside the block.
 */
function renderFamilyLine(row: Row, isMatch: boolean): string {
  return isMatch ? `${row.raw}   ; <- this event` : row.raw;
}

/**
 * Compute the family window around `idx`: walk outward while neighbours share
 * the same first-segment prefix, capped at FAMILY_LINE_CAP either side.
 * Returns inclusive [lo, hi] indices into `rows`.
 */
function familyBounds(rows: Row[], idx: number): { lo: number; hi: number } {
  const matched = rows[idx];
  if (!matched) throw new Error("wow-event-info: matched event index is out of range");
  const prefix = familyPrefix(matched.name);
  let lo = idx;
  let hi = idx;
  let above = 0;
  while (lo > 0 && above < FAMILY_LINE_CAP) {
    const candidate = rows[lo - 1]!;
    if (familyPrefix(candidate.name) !== prefix) break;
    lo--;
    above++;
  }
  let below = 0;
  while (hi < rows.length - 1 && below < FAMILY_LINE_CAP) {
    const candidate = rows[hi + 1]!;
    if (familyPrefix(candidate.name) !== prefix) break;
    hi++;
    below++;
  }
  return { lo, hi };
}

function renderMatch(event: string, rows: Row[], idx: number): string {
  const row = rows[idx]!;
  const prefix = familyPrefix(row.name);
  let { lo, hi } = familyBounds(rows, idx);

  const buildBody = (
    loIdx: number,
    hiIdx: number,
    droppedAbove: number,
    droppedBelow: number,
  ): string => {
    const familyLines: string[] = [];
    if (droppedAbove > 0) {
      familyLines.push(`... +${droppedAbove} more events with prefix ${prefix}_ above`);
    }
    for (let i = loIdx; i <= hiIdx; i++) {
      const familyRow = rows[i];
      if (!familyRow) {
        throw new Error("wow-event-info: family event index is out of range");
      }
      familyLines.push(renderFamilyLine(familyRow, i === idx));
    }
    if (droppedBelow > 0) {
      familyLines.push(`... +${droppedBelow} more events with prefix ${prefix}_ below`);
    }
    const familyText = familyLines.join("\n");
    const fence = fenceFor(familyText);

    const payloadLine =
      row.payload !== null && row.payload.length > 0 ? row.payload : "(no payload)";

    return [
      `# ${event}`,
      "",
      "## Payload",
      payloadLine,
      "",
      "## Source",
      `${REL_PATH}:${row.lineNo}`,
      "",
      "## Related events in the same family",
      `${fence}text`,
      familyText,
      fence,
      "",
      "## Note",
      "Payload arg types are not annotated in Event.lua; arg names are descriptive only.",
      `For full semantics including firing order, fetch the wiki page via wow-wiki-fetch (URL: https://warcraft.wiki.gg/wiki/${event}).`,
      "",
    ].join("\n");
  };

  let droppedAbove = 0;
  let droppedBelow = 0;
  let body = buildBody(lo, hi, droppedAbove, droppedBelow);

  // Defensive cap: trim family edges if rendered body exceeds budget. The
  // 30-line cap above keeps this unreachable for the current data set, but
  // we honour the explicit instruction in the delegation.
  while (Buffer.byteLength(body, "utf8") > BUDGET && (lo < idx || hi > idx)) {
    if (hi > idx) {
      hi--;
      droppedBelow++;
    } else if (lo < idx) {
      lo++;
      droppedAbove++;
    }
    body = buildBody(lo, hi, droppedAbove, droppedBelow);
  }

  if (Buffer.byteLength(body, "utf8") > BUDGET) {
    const marker = "\n\n... [truncated to 40000-byte limit]\n";
    return truncateUtf8(body, BUDGET - Buffer.byteLength(marker, "utf8")) + marker;
  }

  return body;
}

function renderNoMatch(event: string, rows: Row[]): string {
  const wanted = familyPrefix(event);
  let suggestions = rows
    .filter((r) => familyPrefix(r.name) === wanted)
    .map((r) => r.name);

  // Fallback: shared 3-char prefix when the family bucket is empty.
  if (suggestions.length === 0 && event.length >= 3) {
    const head = event.slice(0, 3);
    suggestions = rows.filter((r) => r.name.startsWith(head)).map((r) => r.name);
  }

  // De-dupe + alphabetise + cap.
  suggestions = Array.from(new Set(suggestions)).sort();
  const truncated = suggestions.length > SUGGESTION_CAP;
  const shown = suggestions.slice(0, SUGGESTION_CAP);

  const lines: string[] = [
    `# ${event}`,
    "",
    `No event by this exact name in ${REL_PATH}.`,
    "",
  ];

  if (shown.length > 0) {
    lines.push(`## Closest same-prefix events (prefix \`${wanted}_\`)`);
    for (const name of shown) {
      lines.push(`- ${name}`);
    }
    if (truncated) {
      lines.push(
        `- ... +${suggestions.length - SUGGESTION_CAP} more with prefix ${wanted}_`,
      );
    }
    lines.push("");
  } else {
    lines.push("No same-prefix events found either.");
    lines.push("");
  }

  lines.push("## Note");
  lines.push(
    "This tool does not fuzzy-match. If you suspect a typo, retry with the exact name.",
  );
  lines.push(
    `The wiki may carry it at https://warcraft.wiki.gg/wiki/${event} if it is a real event.`,
  );
  lines.push("");

  return truncateUtf8(lines.join("\n"), BUDGET);
}

export default defineTool({
  description:
    "Look up a single WoW frame event by exact name in Annotations/Core/Data/Event.lua. Returns its payload signature and a same-prefix family window for orientation. No fuzzy/prefix mode; no wiki fetch.",
  args: {
    event: z.string().min(1),
  },
  async execute({ event }) {
    const normalised = event.trim().toUpperCase();
    if (normalised.length === 0) {
      throw new Error("wow-event-info: event must be non-empty");
    }
    if (normalised.length > 100) {
      throw new Error("wow-event-info: event exceeds 100 characters");
    }
    if (!/^[A-Z0-9_]+$/.test(normalised)) {
      throw new Error(
        "wow-event-info: event must contain only A-Z, 0-9, and underscore",
      );
    }

    let raw: string;
    try {
      raw = await readFile(ABS_PATH, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`wow-event-info: failed reading event catalog: ${message}`);
    }

    let rows: Row[];
    try {
      rows = parseRows(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`wow-event-info: failed parsing event catalog: ${message}`);
    }

    const idx = rows.findIndex((r) => r.name === normalised);
    if (idx === -1) {
      return renderNoMatch(normalised, rows);
    }
    return renderMatch(normalised, rows, idx);
  },
});
