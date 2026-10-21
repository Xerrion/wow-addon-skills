import { z } from "zod";
import { defineTool } from "./runtime.ts";

/**
 * wow-wiki-fetch: fetch a single warcraft.wiki.gg page and render it as
 * Markdown. The lowest-level escape hatch for the agent when the curated
 * annotation tree does not have what it needs.
 *
 * Article lookup contract:
 *   - one arg (`page`): slug, path, or full warcraft.wiki.gg URL.
 *   - returns `{ output, metadata: { url, redirectedFrom?, categories } }`.
 *   - no cache, no auto page-type detection, no retail/classic toggle.
 *   - 40 KB self-cap with truncation at H2 boundary.
 *   - 404 / `class="noarticletext"` returns a structured no-match body, NOT a throw.
 *   - HTTP 5xx / network failure throws.
 *
 * Anti-regression non-negotiables (each is observable in this file):
 *   1. Article content is sliced from `<div id="mw-content-text">`. The inner
 *      `mw-parser-output` div is intentionally NOT used as the anchor and the
 *      literal string never appears in source or output.
 *   2. `<pre>` blocks are wrapped with `fenceFor`, so embedded backticks in a
 *      Blizzard signature never collide with the outer fence.
 *   3. Redirect detection is two-pronged (HTTP final URL + inline
 *      `wgRedirectedFrom`); when either fires, the metadata carries
 *      `redirectedFrom` and a "Redirected from" line is rendered.
 *   4. 404 responses render an explicit "does not exist" no-match body with
 *      empty `metadata.categories` instead of pretending the page exists.
 *   5. Self-cap at 40 KB; truncation at
 *      section boundary plus an explicit tail.
 */

const BUDGET = 40_000;
const MAX_INPUT_LEN = 300;
const USER_AGENT = "wow-wiki-fetch/1.0 (local MCP tool; +https://warcraft.wiki.gg/)";
const BASE = "https://warcraft.wiki.gg/wiki/";
const WIKI_ORIGIN = "https://warcraft.wiki.gg";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

// --- Generic helpers ------------------------------------------------------

/** Fence wider than any backtick run in `content`, min 3. Anti-regression #2. */
function fenceFor(content: string): string {
  let max = 0;
  const re = /`+/g;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    if (m[0].length > max) max = m[0].length;
  }
  return "`".repeat(Math.max(3, max + 1));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return "";
      }
    });
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Decode entities, strip tags, collapse whitespace runs. Inline text only. */
function clean(s: string): string {
  return decodeEntities(stripTags(s))
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

function markdownLink(href: string, body: string): string {
  const label = clean(body).replace(/([\\[\]])/g, "\\$1");
  if (label.length === 0) return "";
  let url: URL;
  try {
    url = new URL(decodeEntities(href), WIKI_ORIGIN);
  } catch {
    return label;
  }
  if (url.origin !== WIKI_ORIGIN || !url.pathname.startsWith("/wiki/")) {
    return label;
  }
  const target =
    url.origin === WIKI_ORIGIN ? `${url.pathname}${url.search}${url.hash}` : url.href;
  return `[${label}](${target.replace(/[()]/g, (char) => `\\${char}`)})`;
}

function cleanInline(s: string): string {
  const linked = s.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, body: string) => markdownLink(href, body),
  );
  return clean(linked);
}

// --- HTML extraction ------------------------------------------------------

function extractTitle(html: string): string {
  const h1 = /<h1\b[^>]*id\s*=\s*["']firstHeading["'][^>]*>([\s\S]*?)<\/h1>/i.exec(
    html,
  );
  if (h1) {
    const t = clean(h1[1]!);
    if (t.length > 0) return t;
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) {
    return clean(t[1]!).replace(/\s*[-|–—]\s*Warcraft Wiki.*$/i, "");
  }
  return "";
}

function isNoArticle(html: string): boolean {
  return /class\s*=\s*["'][^"']*\bnoarticletext\b/i.test(html);
}

/**
 * Scrape `wgRedirectedFrom` from the inline RLCONF JS. MediaWiki sometimes
 * serves redirect targets without an HTTP redirect, so the final URL check
 * alone is insufficient (wiki research §redirects).
 */
function extractRedirectedFromSlug(html: string): string | null {
  const m = /"wgRedirectedFrom"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(html);
  if (!m?.[1]) return null;
  return m[1]?.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\");
}

function extractCategories(html: string): string[] {
  const start = html.search(/<div\b[^>]*id\s*=\s*["']catlinks["']/i);
  if (start === -1) return [];
  const slice = html.slice(start, start + 80_000);
  const cats: string[] = [];
  const re =
    /<a\s+[^>]*href\s*=\s*["'][^"']*\/wiki\/Category:([^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(slice); m !== null; m = re.exec(slice)) {
    try {
      const name = decodeURIComponent(m[1]!).replace(/_/g, " ");
      if (!cats.includes(name)) cats.push(name);
    } catch {
      // Skip malformed escape sequences.
    }
  }
  return cats;
}

/**
 * Slice the inner HTML of `<div id="mw-content-text">`. Anti-regression #1:
 * we anchor on `mw-content-text` (the stable outer container), never on the
 * brittle inner parser div. Walks div nesting manually because regex cannot
 * balance.
 */
function sliceContentText(html: string): string | null {
  const re = /<div\b[^>]*id\s*=\s*["']mw-content-text["'][^>]*>/i;
  const m = re.exec(html);
  if (!m) return null;
  const openEnd = m.index + m[0].length;
  let depth = 1;
  let i = openEnd;
  while (i < html.length && depth > 0) {
    if (html.charCodeAt(i) !== 60 /* '<' */) {
      i++;
      continue;
    }
    if (html.startsWith("</div", i)) {
      depth--;
      if (depth === 0) {
        return html.slice(openEnd, i);
      }
      const close = html.indexOf(">", i);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (
      html.startsWith("<div", i) &&
      (html.charCodeAt(i + 4) === 32 ||
        html.charCodeAt(i + 4) === 62 ||
        html.charCodeAt(i + 4) === 9 ||
        html.charCodeAt(i + 4) === 10)
    ) {
      depth++;
      const close = html.indexOf(">", i);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    i++;
  }
  return null;
}

/** Strip chrome bits inside the content slice that would noise up the body. */
function stripBalancedElements(html: string, openingPattern: RegExp): string {
  let output = "";
  let cursor = 0;
  openingPattern.lastIndex = 0;
  for (
    let opening = openingPattern.exec(html);
    opening !== null;
    opening = openingPattern.exec(html)
  ) {
    const tag = opening[1]!;
    const tagPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    tagPattern.lastIndex = opening.index + opening[0].length;
    let depth = 1;
    let closingEnd = -1;
    for (
      let tagMatch = tagPattern.exec(html);
      tagMatch !== null;
      tagMatch = tagPattern.exec(html)
    ) {
      if (/^<\//.test(tagMatch[0])) depth--;
      else if (!/\/>$/.test(tagMatch[0])) depth++;
      if (depth === 0) {
        closingEnd = tagPattern.lastIndex;
        break;
      }
    }
    if (closingEnd === -1) continue;
    output += html.slice(cursor, opening.index);
    cursor = closingEnd;
    openingPattern.lastIndex = closingEnd;
  }
  return output + html.slice(cursor);
}

export function stripChrome(html: string): string {
  // catlinks (collected separately)
  html = stripBalancedElements(html, /<(div)\b[^>]*id\s*=\s*["']catlinks["'][^>]*>/gi);
  html = stripBalancedElements(
    html,
    /<(nav|div|table|ul)\b[^>]*(?:id\s*=\s*["'](?:toc|mw-navigation)["']|class\s*=\s*["'][^"']*(?:navbox|vertical-navbox|toc|mw-navigation|printfooter)[^"']*["'])[^>]*>/gi,
  );
  // edit-section "[edit]" spans on every heading
  html = html.replace(
    /<span\b[^>]*class\s*=\s*["'][^"']*mw-editsection[^"']*["'][\s\S]*?<\/span>/gi,
    "",
  );
  // numbered footnote reference superscripts (the References list itself stays).
  html = html.replace(
    /<sup\b[^>]*class\s*=\s*["'][^"']*reference[^"']*["'][\s\S]*?<\/sup>/gi,
    "",
  );
  return html;
}

// --- Body rendering -------------------------------------------------------

function renderTable(body: string): string {
  const rows: string[][] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (let tr = trRe.exec(body); tr !== null; tr = trRe.exec(body)) {
    const cells: string[] = [];
    const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
    for (let c = cellRe.exec(tr[1]!); c !== null; c = cellRe.exec(tr[1]!)) {
      cells.push(cleanInline(c[2]!).replace(/\|/g, "\\|"));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < cols) r.push("");
  const sep = Array<string>(cols).fill("---");
  const lines: string[] = [];
  lines.push(`| ${rows[0]?.join(" | ")} |`);
  lines.push(`| ${sep.join(" | ")} |`);
  for (let i = 1; i < rows.length; i++) {
    lines.push(`| ${rows[i]?.join(" | ")} |`);
  }
  return `\n${lines.join("\n")}\n\n`;
}

function renderDl(body: string): string {
  const re = /<(dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const parts: string[] = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const tag = m[1]?.toLowerCase();
    const text = cleanInline(m[2]!);
    if (text.length === 0) continue;
    if (tag === "dt") parts.push(`**${text}**`);
    else parts.push(`: ${text}`);
  }
  return parts.length > 0 ? `\n${parts.join("\n")}\n\n` : "";
}

function renderList(body: string, marker: string): string {
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  const items: string[] = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const text = cleanInline(m[1]!);
    if (text.length > 0) items.push(`${marker} ${text}`);
  }
  return items.length > 0 ? `\n${items.join("\n")}\n\n` : "";
}

/**
 * Convert a chunk of article HTML to Markdown. Order is intentional:
 * `<pre>` first so its content is decoded and fenced before subsequent
 * passes touch it, then block-level elements top-down.
 */
export function renderHtml(html: string): string {
  let s = html;

  // Pre blocks first: detect lang, decode entities, wrap with safe fence.
  s = s.replace(
    /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi,
    (_, attrs: string, body: string) => {
      const langMatch = /mw-highlight-lang-(\w+)/.exec(attrs);
      const lang = langMatch ? langMatch[1]! : "";
      const text = decodeEntities(stripTags(body))
        .replace(/\r\n?/g, "\n")
        .replace(/\s+$/, "");
      const fence = fenceFor(text);
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  );

  // H3 sub-sections inside an H2 block.
  s = s.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, body: string) => {
    const span =
      /<span\b[^>]*class\s*=\s*["'][^"']*\bmw-headline\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(
        body,
      );
    const text = span ? clean(span[1]!) : clean(body);
    return `\n\n### ${text}\n\n`;
  });

  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, body: string) =>
    renderTable(body),
  );
  s = s.replace(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi, (_, body: string) => renderDl(body));
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, body: string) =>
    renderList(body, "-"),
  );
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, body: string) =>
    renderList(body, "1."),
  );
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, body: string) => {
    const t = cleanInline(body);
    return t.length > 0 ? `\n\n${t}\n\n` : "";
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // Strip remaining structural tags and decode any stray entities.
  s = stripTags(s);
  s = decodeEntities(s);

  // Tidy whitespace without disturbing code fences (fences are bare lines).
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

type Section = { id: string; heading: string; body: string };

function segment(content: string): { lead: string; sections: Section[] } {
  const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const matches: { idx: number; len: number; id: string; heading: string }[] = [];
  for (let m = h2Re.exec(content); m !== null; m = h2Re.exec(content)) {
    const inner = m[1]!;
    const sp =
      /<span\b[^>]*class\s*=\s*["'][^"']*\bmw-headline\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(
        inner,
      );
    if (!sp) continue;
    const idMatch = /\bid\s*=\s*["']([^"']+)["']/.exec(sp[0]);
    if (!idMatch) continue;
    matches.push({
      idx: m.index,
      len: m[0].length,
      id: idMatch[1]!,
      heading: clean(sp[1]!),
    });
  }
  if (matches.length === 0) return { lead: content, sections: [] };
  const lead = content.slice(0, matches[0]?.idx);
  const sections: Section[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const end = i + 1 < matches.length ? matches[i + 1]?.idx : content.length;
    sections.push({
      id: cur.id,
      heading: cur.heading,
      body: content.slice(cur.idx + cur.len, end),
    });
  }
  return { lead, sections };
}

// --- Top-level orchestration ---------------------------------------------

function buildUrl(input: string): string {
  return /^https?:\/\//i.test(input) ? input : BASE + input;
}

function normaliseInput(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return trimmed.replace(/\s+/g, "_");
}

function parseAllowedUrl(value: string, context: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`wow-wiki-fetch: invalid ${context} URL: ${value}`);
  }
  if (
    url.origin !== WIKI_ORIGIN ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      `wow-wiki-fetch: ${context} URL must use ${WIKI_ORIGIN} (got ${url.origin})`,
    );
  }
  return url;
}

export async function fetchWithRedirects(
  requestedUrl: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{
  response: Response;
  finalUrl: string;
  redirectSource: string | undefined;
}> {
  let currentUrl = requestedUrl;
  let redirectSource: string | undefined;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        throw new Error(
          `wow-wiki-fetch: request timed out after ${timeoutMs} ms for ${currentUrl}`,
        );
      }
      throw new Error(`wow-wiki-fetch: network error for ${currentUrl}: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const responseUrl = response.url || currentUrl;
      try {
        parseAllowedUrl(responseUrl, "response");
      } catch (error) {
        await response.body?.cancel(error);
        throw error;
      }
      return {
        response,
        finalUrl: responseUrl,
        redirectSource,
      };
    }

    await response.body?.cancel();
    if (redirects === MAX_REDIRECTS) {
      throw new Error(`wow-wiki-fetch: too many redirects (maximum ${MAX_REDIRECTS})`);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(
        `wow-wiki-fetch: HTTP ${response.status} redirect missing Location header`,
      );
    }
    if (!redirectSource) redirectSource = currentUrl;
    currentUrl = parseAllowedUrl(new URL(location, currentUrl).href, "redirect").href;
  }
  throw new Error("wow-wiki-fetch: redirect handling failed");
}

export async function readBoundedBody(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  const isDeclaredOversized =
    Number.isFinite(declaredLength) && declaredLength > maxBytes;
  if (!response.body) {
    if (isDeclaredOversized) {
      throw new Error(`wow-wiki-fetch: response body exceeds ${maxBytes} bytes`);
    }
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  try {
    if (isDeclaredOversized) {
      throw new Error(`wow-wiki-fetch: response body exceeds ${maxBytes} bytes`);
    }
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `wow-wiki-fetch: response body timed out after ${REQUEST_TIMEOUT_MS} ms`,
        );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `wow-wiki-fetch: response body timed out after ${REQUEST_TIMEOUT_MS} ms`,
              ),
            ),
          remainingMs,
        );
      });
      const { done, value } = await Promise.race([reader.read(), timeout]).finally(
        () => {
          if (timer) clearTimeout(timer);
        },
      );
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`wow-wiki-fetch: response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch (cancelError) {
      const readMessage = error instanceof Error ? error.message : String(error);
      const cancelMessage =
        cancelError instanceof Error ? cancelError.message : String(cancelError);
      throw new Error(
        `wow-wiki-fetch: failed reading response body: ${readMessage}; failed cancelling response body: ${cancelMessage}`,
      );
    }
    if (error instanceof Error && error.message.startsWith("wow-wiki-fetch:")) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`wow-wiki-fetch: failed reading response body: ${message}`);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`wow-wiki-fetch: response body is not valid UTF-8: ${message}`);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function renderNoMatch(
  originalInput: string,
  requestedUrl: string,
  redirectedFrom: string | undefined,
): string {
  const lines: string[] = [
    `# ${originalInput}`,
    "",
    `No wiki page exists at ${requestedUrl}.`,
    "",
    "The server returned HTTP 404 (or a `noarticletext` body). The page does not exist at that slug.",
    "",
    "Slug conventions:",
    "- Documented C_ API: `API_C_<Namespace>.<Method>` (e.g. `API_C_Item.GetItemInfo`).",
    "- Global API: `API_<FuncName>` (e.g. `API_UnitName`, `API_CreateFrame`).",
    "- Event: raw `EVENT_NAME` (e.g. `PLAYER_LOGIN`).",
    "- Widget type: `UIOBJECT_<Widget>` (e.g. `UIOBJECT_Frame`).",
    "- Enum: `Enum.<Name>` (e.g. `Enum.ItemQuality`).",
    "- XML element: `XML/<Element>`. Note: the bare slug `Frame` redirects to `XML/Frame`; for the widget use `UIOBJECT_Frame`.",
    "",
    "If you do not know the slug, try `wow-api-lookup` or `wow-event-info` first - they resolve names against curated annotations and surface the canonical wiki URL.",
    "",
  ];
  if (redirectedFrom) {
    lines.splice(2, 0, `Redirected from \`${redirectedFrom}\``, "");
  }
  return lines.join("\n");
}

function renderArticle(opts: {
  title: string;
  url: string;
  redirectedFrom: string | undefined;
  categories: string[];
  lead: string;
  sections: Section[];
}): { output: string; truncated: boolean } {
  const header: string[] = [`# ${opts.title || "(untitled)"}`, ""];
  header.push(`> Source: ${opts.url}`);
  if (opts.redirectedFrom) {
    header.push(`> Redirected from: \`${opts.redirectedFrom}\``);
  }
  if (opts.categories.length > 0) {
    header.push(`> Categories: ${opts.categories.join(", ")}`);
  }
  header.push("");

  let body = `${header.join("\n")}\n`;

  const leadMd = renderHtml(stripChrome(opts.lead));
  if (leadMd.length > 0) body += `${leadMd}\n\n`;

  const reserveBytes = 200; // headroom for the truncation tail.
  let truncated = false;

  for (const sec of opts.sections) {
    const secMd = renderHtml(stripChrome(sec.body));
    const block = `## ${sec.heading}\n\n${secMd}\n\n`;
    if (Buffer.byteLength(body + block, "utf8") + reserveBytes > BUDGET) {
      truncated = true;
      break;
    }
    body += block;
  }

  if (!truncated && Buffer.byteLength(body, "utf8") > BUDGET) {
    truncated = true;
    body = truncateUtf8(body, BUDGET - reserveBytes);
  }

  if (truncated) {
    body = body.replace(/\s+$/, "");
    body += `\n\n... article truncated at 40 KB; see ${opts.url} for the full page.\n`;
  }

  return { output: body, truncated };
}

export default defineTool({
  description:
    "Fetch a single page from warcraft.wiki.gg by slug or full URL and render it as Markdown. One arg `page` (slug like `API_C_Item.GetItemInfo`, `PLAYER_LOGIN`, `UIOBJECT_Frame`, or a full https://warcraft.wiki.gg/wiki/... URL). Returns `{ output, metadata: { url, redirectedFrom?, categories } }`. No caching, no auto page-type detection, no retail/classic toggle (the wiki has none).",
  args: {
    page: z.string().min(1),
  },
  async execute({ page }) {
    if (page.trim().length === 0) {
      throw new Error("wow-wiki-fetch: page must be non-empty");
    }
    if (/[\r\n]/.test(page)) {
      throw new Error("wow-wiki-fetch: page must not contain newlines");
    }
    if (page.length > MAX_INPUT_LEN) {
      throw new Error(`wow-wiki-fetch: page exceeds ${MAX_INPUT_LEN} characters`);
    }

    const slug = normaliseInput(page);
    const requestedUrl = buildUrl(slug);

    parseAllowedUrl(requestedUrl, "request");

    const {
      response: res,
      finalUrl,
      redirectSource,
    } = await fetchWithRedirects(requestedUrl);
    const html = await readBoundedBody(res);

    // 404 / noarticletext → structured no-match body (NOT a throw, NOT a
    // pretend-success). Anti-regression #4.
    if (res.status === 404 || isNoArticle(html)) {
      return {
        output: renderNoMatch(page, requestedUrl, undefined),
        metadata: {
          url: requestedUrl,
          categories: [] as string[],
        },
      };
    }

    if (res.status !== 200) {
      throw new Error(`wow-wiki-fetch: HTTP ${res.status}: ${requestedUrl}`);
    }

    // Anti-regression #3: detect redirects via BOTH the HTTP final URL AND
    // the inline `wgRedirectedFrom` JS variable. MediaWiki sometimes serves
    // the redirect target inline without a 30x, so the HTTP signal alone is
    // not sufficient.
    const wgRedir = extractRedirectedFromSlug(html);
    const redirectedFrom = redirectSource
      ? redirectSource
      : wgRedir
        ? wgRedir
        : undefined;

    const title = extractTitle(html);
    const categories = extractCategories(html);
    const content = sliceContentText(html);

    if (content === null) {
      // 200 with no `mw-content-text` container is anomalous (special pages,
      // changed layout). Surface what we have without inventing structure.
      const fallback = [
        `# ${title || page}`,
        "",
        `> Source: ${finalUrl}`,
        ...(redirectedFrom ? [`> Redirected from: \`${redirectedFrom}\``] : []),
        ...(categories.length > 0 ? [`> Categories: ${categories.join(", ")}`] : []),
        "",
        "(Page returned 200 but no article container was found at the expected anchor. The wiki may have changed its layout, or this is a special page without article content.)",
        "",
      ].join("\n");
      return {
        output: fallback,
        metadata: {
          url: finalUrl,
          ...(redirectedFrom ? { redirectedFrom } : {}),
          categories,
        },
      };
    }

    const { lead, sections } = segment(content);
    const { output } = renderArticle({
      title,
      url: finalUrl,
      redirectedFrom,
      categories,
      lead,
      sections,
    });

    return {
      output,
      metadata: {
        url: finalUrl,
        ...(redirectedFrom ? { redirectedFrom } : {}),
        categories,
      },
    };
  },
});
