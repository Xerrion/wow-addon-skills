import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type CallToolResult,
  Client,
  ProtocolError,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

const serverPath = fileURLToPath(new URL("../dist/mcp/server.js", import.meta.url));

function text(result: CallToolResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

describe("local MCP server over stdio", { timeout: 20_000 }, () => {
  let root: string;
  let client: Client;
  let transport: StdioClientTransport;
  const protocolErrors: Error[] = [];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wow-mcp-"));
    const annotations = join(root, "annotations");
    const framexml = join(root, "framexml");
    const apiDir = join(
      annotations,
      "Annotations/Core/Blizzard_APIDocumentationGenerated",
    );
    const dataDir = join(annotations, "Annotations/Core/Data");
    const sourceDir = join(framexml, "live/Annotations/AddOns/Blizzard_Test");
    await Promise.all([
      mkdir(apiDir, { recursive: true }),
      mkdir(dataDir, { recursive: true }),
      mkdir(sourceDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(apiDir, "Item.lua"),
        "---@param itemID number\n---@return string name\nfunction C_Item.GetItemInfo(itemID) end\n",
      ),
      writeFile(
        join(dataDir, "Event.lua"),
        '---|"PLAYER_LOGIN"\n---|"PLAYER_LOGOUT" # `reason`\n',
      ),
      writeFile(
        join(sourceDir, "Main.lua.annotated.lua"),
        "local luaMarker = true\nfunction NeedleFunction() end\n",
      ),
      writeFile(
        join(sourceDir, "Main.xml.annotated.lua"),
        '<Frame name="NeedleXmlFrame"/>\n',
      ),
    ]);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: root,
      env: {
        ...getDefaultEnvironment(),
        WOW_ANNOTATIONS_ROOT: annotations,
        WOW_FRAMEXML_ROOT: framexml,
        WOW_RG_COMMAND: "rg",
      },
      stderr: "pipe",
    });
    client = new Client(
      { name: "wow-addon-integration-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    client.onerror = (error) => protocolErrors.push(error);
    await client.connect(transport);
  });

  after(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(protocolErrors, [], "stdout must contain valid MCP messages");
  });

  test("negotiates MCP and lists the four portable tool schemas", async () => {
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    assert.equal(client.getServerVersion()?.name, "wow-addon");
    assert.ok(client.getServerCapabilities()?.tools);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "wow-api-lookup",
      "wow-blizzard-source",
      "wow-event-info",
      "wow-wiki-fetch",
    ]);

    const requiredByTool: Record<string, string[]> = {
      "wow-api-lookup": ["query"],
      "wow-event-info": ["event"],
      "wow-blizzard-source": ["pattern"],
      "wow-wiki-fetch": ["page"],
    };
    for (const tool of tools) {
      assert.deepEqual(tool.inputSchema.required, requiredByTool[tool.name]);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    const source = tools.find((tool) => tool.name === "wow-blizzard-source");
    assert.ok(source);
    const properties = source.inputSchema.properties as Record<
      string,
      { default?: string; enum?: string[] }
    >;
    const { flavor, scope } = properties;
    assert.ok(flavor);
    assert.ok(scope);
    assert.equal(flavor.default, "live");
    assert.deepEqual(flavor.enum, [
      "live",
      "retail",
      "classic",
      "classic_anniversary",
      "classic_era",
    ]);
    assert.equal(scope.default, "lua");
    assert.deepEqual(scope.enum, ["lua", "xml", "all"]);
  });

  test("supports the legacy 2025 initialize handshake and tool calls", async () => {
    const legacyTransport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: root,
      env: {
        ...getDefaultEnvironment(),
        WOW_ANNOTATIONS_ROOT: join(root, "annotations"),
        WOW_FRAMEXML_ROOT: join(root, "framexml"),
        WOW_RG_COMMAND: "rg",
      },
      stderr: "pipe",
    });
    const legacyClient = new Client(
      { name: "legacy-mcp-test", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );
    legacyClient.onerror = (error) => protocolErrors.push(error);
    try {
      await legacyClient.connect(legacyTransport, { timeout: 5_000 });
      assert.equal(legacyClient.getProtocolEra(), "legacy");
      assert.ok(legacyClient.getNegotiatedProtocolVersion()?.startsWith("2025-"));
      assert.equal((await legacyClient.listTools()).tools.length, 4);
      const result = await legacyClient.callTool({
        name: "wow-event-info",
        arguments: { event: "PLAYER_LOGIN" },
      });
      assert.ok(!result.isError);
      assert.ok(text(result).includes("# PLAYER_LOGIN"));
    } finally {
      await legacyClient.close();
      await legacyTransport.close();
    }
  });

  test("looks up local API annotations and event details from an unrelated cwd", async () => {
    const api = await client.callTool({
      name: "wow-api-lookup",
      arguments: { query: "C_Item.GetItemInfo" },
    });
    assert.ok(!api.isError);
    assert.ok(text(api).includes("---@param itemID number"));
    assert.ok(text(api).includes("---@return string name"));
    assert.deepEqual(api.structuredContent, { output: text(api) });

    const event = await client.callTool({
      name: "wow-event-info",
      arguments: { event: "player_logout" },
    });
    assert.ok(!event.isError);
    assert.ok(text(event).includes("# PLAYER_LOGOUT"));
    assert.ok(text(event).includes("`reason`"));
    assert.deepEqual(event.structuredContent, { output: text(event) });
  });

  test("applies source defaults and preserves structured metadata and relative paths", async () => {
    const result = await client.callTool({
      name: "wow-blizzard-source",
      arguments: { pattern: "Needle" },
    });
    assert.ok(!result.isError);
    assert.deepEqual(result.structuredContent, {
      output: text(result),
      metadata: { flavor: "live", matchCount: 1, selfTruncated: false },
    });
    assert.ok(text(result).includes("AddOns/Blizzard_Test/Main.lua.annotated.lua"));
    assert.ok(text(result).includes("NeedleFunction"));
    assert.ok(!text(result).includes("NeedleXmlFrame"));
    assert.ok(!text(result).includes(root));
  });

  test("resolves retail to live and includes both file types for scope all", async () => {
    const result = await client.callTool({
      name: "wow-blizzard-source",
      arguments: { pattern: "Needle", flavor: "retail", scope: "all" },
    });
    assert.ok(!result.isError);
    assert.deepEqual(result.structuredContent, {
      output: text(result),
      metadata: { flavor: "live", matchCount: 2, selfTruncated: false },
    });
    assert.ok(text(result).includes("NeedleFunction"));
    assert.ok(text(result).includes("NeedleXmlFrame"));
  });

  test("returns a successful no-match result with zero matches", async () => {
    const result = await client.callTool({
      name: "wow-blizzard-source",
      arguments: { pattern: "does_not_exist" },
    });
    assert.ok(!result.isError);
    assert.deepEqual(result.structuredContent, {
      output: text(result),
      metadata: { flavor: "live", matchCount: 0, selfTruncated: false },
    });
    assert.ok(text(result).includes("No matches"));
  });

  test("reports missing or invalid arguments as tool errors", async () => {
    const invalidCalls = [
      { name: "wow-api-lookup", arguments: {} },
      { name: "wow-event-info", arguments: { event: 42 } },
      {
        name: "wow-blizzard-source",
        arguments: { pattern: "Needle", flavor: "invalid" },
      },
      {
        name: "wow-blizzard-source",
        arguments: { pattern: "Needle", scope: "invalid" },
      },
      {
        name: "wow-api-lookup",
        arguments: { query: "C_Item.GetItemInfo", unexpected: true },
      },
    ];
    for (const call of invalidCalls) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.ok(text(result).length > 0);
    }
  });

  test("reports an unavailable source flavor and invalid regex as tool errors", async () => {
    const missing = await client.callTool({
      name: "wow-blizzard-source",
      arguments: { pattern: "Needle", flavor: "classic" },
    });
    assert.equal(missing.isError, true);
    assert.ok(text(missing).includes("flavor 'classic' not available"));

    const regex = await client.callTool({
      name: "wow-blizzard-source",
      arguments: { pattern: "[" },
    });
    assert.equal(regex.isError, true);
    assert.ok(text(regex).includes("wow-blizzard-source:"));
  });

  test("rejects a wiki URL on another host before making a request", async () => {
    const result = await client.callTool({
      name: "wow-wiki-fetch",
      arguments: { page: "https://example.com/wiki/Test" },
    });
    assert.equal(result.isError, true);
    assert.ok(text(result).includes("URL must use https://warcraft.wiki.gg"));
  });

  test("rejects an unknown tool with an MCP protocol error", async () => {
    await assert.rejects(
      client.callTool({ name: "unknown-tool", arguments: {} }),
      (error: unknown) => error instanceof ProtocolError && error.code === -32602,
    );
  });
});
