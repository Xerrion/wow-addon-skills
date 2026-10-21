import { afterEach, beforeEach, describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
const originalFetch = globalThis.fetch;

async function importFresh(path: string) {
  return import(`${path}?test=${crypto.randomUUID()}`);
}

function messageIncludes(expected: string) {
  return (error: unknown) => error instanceof Error && error.message.includes(expected);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wow-tools-"));
});

afterEach(async () => {
  mock.restore();
  globalThis.fetch = originalFetch;
  delete process.env.WOW_ANNOTATIONS_ROOT;
  delete process.env.WOW_FRAMEXML_ROOT;
  delete process.env.WOW_RG_COMMAND;
  await rm(root, { recursive: true, force: true });
});

describe("defaultDataRoot (platform-native annotation storage)", () => {
  const toolFiles = [
    "./wow-api-lookup.ts",
    "./wow-event-info.ts",
    "./wow-blizzard-source.ts",
  ] as const;

  for (const file of toolFiles) {
    test(`${file} resolves Windows and Unix data roots identically`, async () => {
      const { defaultDataRoot } = await importFresh(file);

      assert.equal(
        defaultDataRoot("wow-annotations", "win32", {
          LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local",
        }),
        join("C:\\Users\\you\\AppData\\Local", "wow-annotations"),
      );
      assert.equal(
        defaultDataRoot("wow-framexml", "win32", {}),
        join(homedir(), "AppData", "Local", "wow-framexml"),
      );
      assert.equal(
        defaultDataRoot("wow-annotations", "darwin", {}),
        join(homedir(), ".local", "share", "wow-annotations"),
      );
      assert.equal(
        defaultDataRoot("wow-annotations", "linux", {
          LOCALAPPDATA: "ignored",
        }),
        join(homedir(), ".local", "share", "wow-annotations"),
      );
    });
  }
});

describe("wow-api-lookup", () => {
  test("returns complete long annotation signatures", async () => {
    process.env.WOW_ANNOTATIONS_ROOT = root;
    const apiDir = join(root, "Annotations/Core/Blizzard_APIDocumentationGenerated");
    await mkdir(apiDir, { recursive: true });
    const params = Array.from({ length: 14 }, (_, i) => `---@param p${i} string`);
    await writeFile(
      join(apiDir, "Item.lua"),
      `${params.join("\n")}\n---@return string result\nfunction C_Item.GetItemInfo(p0) end\n`,
    );
    const tool = (await importFresh("./wow-api-lookup.ts")).default;
    const output = await tool.execute({ query: "C_Item.GetItemInfo" });
    assert.ok(output.includes("---@param p0 string"));
    assert.ok(output.includes("---@param p13 string"));
    assert.ok(output.includes("---@return string result"));
  });

  test("surfaces non-absence Classic override read failures", async () => {
    process.env.WOW_ANNOTATIONS_ROOT = root;
    const apiDir = join(root, "Annotations/Core/Blizzard_APIDocumentationGenerated");
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(apiDir, "Item.lua"), "function C_Item.GetItemInfo() end\n");
    await mkdir(join(root, "Annotations/Core/Data/Classic.lua"), {
      recursive: true,
    });
    const tool = (await importFresh("./wow-api-lookup.ts")).default;
    await assert.rejects(
      tool.execute({ query: "C_Item.GetItemInfo" }),
      messageIncludes("wow-api-lookup: failed reading optional Classic overrides"),
    );
  });
});

describe("wow-event-info", () => {
  test("wraps missing and corrupt catalog errors", async () => {
    process.env.WOW_ANNOTATIONS_ROOT = root;
    let tool = (await importFresh("./wow-event-info.ts")).default;
    await assert.rejects(
      tool.execute({ event: "PLAYER_LOGIN" }),
      messageIncludes("wow-event-info: failed reading event catalog"),
    );

    const dataDir = join(root, "Annotations/Core/Data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "Event.lua"), '---|"BROKEN" trailing garbage\n');
    tool = (await importFresh("./wow-event-info.ts")).default;
    await assert.rejects(
      tool.execute({ event: "PLAYER_LOGIN" }),
      messageIncludes("wow-event-info: failed parsing event catalog"),
    );
  });

  test("caps UTF-8 without splitting a multibyte character", async () => {
    const { truncateUtf8 } = await importFresh("./wow-event-info.ts");
    const output = truncateUtf8("abc😀xyz", 6);
    assert.ok(Buffer.byteLength(output, "utf8") <= 6);
    assert.equal(output, "abc");
  });

  test("returns the existing exact-match public path", async () => {
    process.env.WOW_ANNOTATIONS_ROOT = root;
    const dataDir = join(root, "Annotations/Core/Data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "Event.lua"),
      '---|"PLAYER_LOGIN"\n---|"PLAYER_LOGOUT" # `reason`\n',
    );
    const tool = (await importFresh("./wow-event-info.ts")).default;
    const output = await tool.execute({ event: "player_logout" });
    assert.ok(output.includes("# PLAYER_LOGOUT"));
    assert.ok(output.includes("`reason`"));
  });

  test("caps an oversized exact event row with an explicit marker", async () => {
    process.env.WOW_ANNOTATIONS_ROOT = root;
    const dataDir = join(root, "Annotations/Core/Data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "Event.lua"),
      `---|"PLAYER_LOGIN" # \`${"😀".repeat(11_000)}\`\n`,
    );
    const tool = (await importFresh("./wow-event-info.ts")).default;
    const output = await tool.execute({ event: "PLAYER_LOGIN" });
    assert.ok(Buffer.byteLength(output, "utf8") <= 40_000);
    assert.ok(output.endsWith("... [truncated to 40000-byte limit]\n"));
    assert.ok(!output.includes("�"));
  });
});

describe("wow-blizzard-source", () => {
  test("reports capped matches without claiming an exact total", async () => {
    process.env.WOW_FRAMEXML_ROOT = root;
    const annotations = join(root, "live/Annotations");
    await mkdir(annotations, { recursive: true });
    await writeFile(
      join(annotations, "Many.lua.annotated.lua"),
      Array.from({ length: 8 }, (_, i) => `needle ${i}`).join("\n"),
    );
    const tool = (await importFresh("./wow-blizzard-source.ts")).default;
    const result = await tool.execute({
      pattern: "needle",
      flavor: "live",
      scope: "lua",
    });
    assert.equal(result.metadata.matchCount, 5);
    assert.ok(result.output.includes("capped at 5 per file"));
    assert.ok(!result.output.includes("3 more matches"));
  });

  test("normalizes missing rg failures", async () => {
    process.env.WOW_FRAMEXML_ROOT = root;
    process.env.WOW_RG_COMMAND = join(root, "missing-rg");
    await mkdir(join(root, "live/Annotations"), { recursive: true });
    const tool = (await importFresh("./wow-blizzard-source.ts")).default;
    await assert.rejects(
      tool.execute({ pattern: "needle", flavor: "live", scope: "lua" }),
      messageIncludes("wow-blizzard-source: failed to launch rg"),
    );
  });

  test("keeps truncation counts as lower bounds", async () => {
    process.env.WOW_FRAMEXML_ROOT = root;
    const annotations = join(root, "live/Annotations");
    await mkdir(annotations, { recursive: true });
    await writeFile(
      join(annotations, "Large.lua.annotated.lua"),
      `needle ${"x".repeat(41_000)}\n`,
    );
    await writeFile(join(annotations, "Other.lua.annotated.lua"), "needle\n");
    const tool = (await importFresh("./wow-blizzard-source.ts")).default;
    const result = await tool.execute({
      pattern: "needle",
      flavor: "live",
      scope: "lua",
    });
    assert.equal(result.metadata.selfTruncated, true);
    assert.ok(result.metadata.matchCount < 2);
    assert.ok(result.output.includes("more file(s) have matches not shown"));
    assert.ok(Buffer.byteLength(result.output, "utf8") <= 40_000);
  });
});

describe("wow-wiki-fetch helpers", () => {
  test("rejects cross-host redirects before following", async () => {
    const { fetchWithRedirects } = await importFresh("./wow-wiki-fetch.ts");
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/steal" },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await assert.rejects(
      fetchWithRedirects("https://warcraft.wiki.gg/wiki/Test"),
      messageIncludes("wow-wiki-fetch: redirect URL must use"),
    );
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("enforces timeout and streaming byte limits", async () => {
    const { fetchWithRedirects, readBoundedBody } =
      await importFresh("./wow-wiki-fetch.ts");
    globalThis.fetch = mock(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    await assert.rejects(
      fetchWithRedirects("https://warcraft.wiki.gg/wiki/Test", 5),
      messageIncludes("wow-wiki-fetch: request timed out"),
    );

    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
    );
    await assert.rejects(
      readBoundedBody(response, 10),
      messageIncludes("wow-wiki-fetch: response body exceeds 10 bytes"),
    );
  });

  test("cancels a stalled response body when reading times out", async () => {
    const { readBoundedBody } = await importFresh("./wow-wiki-fetch.ts");
    let wasCancelled = false;
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          wasCancelled = true;
        },
      }),
    );
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: TimerHandler) =>
      originalSetTimeout(callback, 0)) as typeof setTimeout;
    try {
      await assert.rejects(
        readBoundedBody(response),
        messageIncludes("wow-wiki-fetch: response body timed out"),
      );
      assert.equal(wasCancelled, true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("cancels a response body rejected by its declared length", async () => {
    const { readBoundedBody } = await importFresh("./wow-wiki-fetch.ts");
    let wasCancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          wasCancelled = true;
        },
      }),
      { headers: { "content-length": "11" } },
    );

    await assert.rejects(
      readBoundedBody(response, 10),
      messageIncludes("wow-wiki-fetch: response body exceeds 10 bytes"),
    );
    assert.equal(wasCancelled, true);
  });

  test("preserves safe article links and removes chrome", async () => {
    const { renderHtml, stripChrome } = await importFresh("./wow-wiki-fetch.ts");
    const html = stripChrome(
      '<div id="toc"><a href="/wiki/Noise">Noise</a></div><p>See <a href="/wiki/API_UnitName">UnitName</a> and <a href="https://example.com">unsafe</a>.</p>',
    );
    const output = renderHtml(html);
    assert.ok(output.includes("[UnitName](/wiki/API_UnitName)"));
    assert.ok(output.includes("unsafe"));
    assert.ok(!output.includes("example.com"));
    assert.ok(!output.includes("Noise"));
  });

  test("removes nested MediaWiki chrome without leaking its tail", async () => {
    const { renderHtml, stripChrome } = await importFresh("./wow-wiki-fetch.ts");
    const html = stripChrome(
      '<div id="toc"><div class="toc-section"><ul><li>Nested noise</li></ul></div><p>Trailing noise</p></div><p>Article body.</p>',
    );
    const output = renderHtml(html);
    assert.equal(output, "Article body.");
    assert.ok(!output.includes("noise"));
  });

  test("removes nested catlinks without leaking sibling chrome", async () => {
    const { renderHtml, stripChrome } = await importFresh("./wow-wiki-fetch.ts");
    const html = stripChrome(
      '<div id="catlinks"><div class="first">First category</div><div class="second">Leaked category</div></div><p>Article body.</p>',
    );
    const output = renderHtml(html);
    assert.equal(output, "Article body.");
    assert.ok(!output.includes("category"));
  });

  test("records only successful redirect metadata", async () => {
    const article = (redirectedFrom?: string) =>
      `<!doctype html><html><head><title>Target - Warcraft Wiki</title><script>RLCONF={${redirectedFrom ? `"wgRedirectedFrom":"${redirectedFrom}"` : ""}}</script></head><body><h1 id="firstHeading">Target</h1><div id="mw-content-text"><p>Article body.</p></div></body></html>`;
    const module = await importFresh("./wow-wiki-fetch.ts");
    const tool = module.default;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(article("Old_Page"), { status: 200 })),
    ) as unknown as typeof fetch;
    const redirected = await tool.execute({ page: "Target" });
    assert.equal(redirected.metadata.redirectedFrom, "Old_Page");

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          '<div class="noarticletext">missing</div><script>RLCONF={"wgRedirectedFrom":"Old_Page"}</script>',
          {
            status: 404,
          },
        ),
      ),
    ) as unknown as typeof fetch;
    const missing = await tool.execute({ page: "Missing" });
    assert.equal(missing.metadata.redirectedFrom, undefined);
  });

  test("records a validated HTTP page redirect", async () => {
    const module = await importFresh("./wow-wiki-fetch.ts");
    const tool = module.default;
    const article =
      '<title>Target - Warcraft Wiki</title><h1 id="firstHeading">Target</h1><div id="mw-content-text"><p>Body.</p></div>';
    let request = 0;
    globalThis.fetch = mock(() => {
      request++;
      if (request === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "/wiki/Target" },
          }),
        );
      }
      return Promise.resolve(new Response(article, { status: 200 }));
    }) as unknown as typeof fetch;
    const result = await tool.execute({ page: "Old" });
    assert.equal(result.metadata.redirectedFrom, "https://warcraft.wiki.gg/wiki/Old");
    assert.equal(result.metadata.url, "https://warcraft.wiki.gg/wiki/Target");
  });
});
