import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { httpClientConfiguration, httpConfiguration } from "./http.ts";

const token = "test-only-token-0123456789abcdef0123456789abcdef";
const publicOrigin = "https://wow-mcp.example.test";
const baseEnv = { WOW_MCP_TOKEN: token };
const entry = fileURLToPath(new URL("../dist/mcp/http-server.mjs", import.meta.url));
const configEntry = fileURLToPath(
  new URL("../dist/mcp/http-config.mjs", import.meta.url),
);

test("HTTP configuration defaults to loopback and requires a usable token", () => {
  const configuration = httpConfiguration(baseEnv);
  assert.equal(configuration.hostname, "127.0.0.1");
  assert.equal(configuration.port, 3000);
  assert.equal(configuration.publicUrl.origin, "http://127.0.0.1:3000");
  for (const value of ["", "too-short", `${token}\n`, ` ${token}`]) {
    assert.throws(() => httpConfiguration({ WOW_MCP_TOKEN: value }), /WOW_MCP_TOKEN/);
  }
});

test("public bindings require an HTTPS URL without credentials or URL metadata", () => {
  assert.throws(
    () => httpConfiguration({ ...baseEnv, WOW_MCP_HOST: "0.0.0.0" }),
    /WOW_MCP_PUBLIC_URL/,
  );
  for (const url of [
    "http://example.test",
    "ftp://example.test",
    "https://user:pass@example.test",
    "https://example.test/wrong",
    "https://example.test/?query=1",
    "https://example.test/#fragment",
  ]) {
    assert.throws(
      () => httpConfiguration({ ...baseEnv, WOW_MCP_PUBLIC_URL: url }),
      /WOW_MCP_PUBLIC_URL/,
    );
  }
  const configuration = httpConfiguration({
    ...baseEnv,
    WOW_MCP_HOST: "0.0.0.0",
    WOW_MCP_PUBLIC_URL: `${publicOrigin}/mcp`,
  });
  assert.equal(configuration.publicUrl.origin, publicOrigin);
  for (const port of ["-1", "65536", "3000extra", "1.5"]) {
    assert.throws(() => httpConfiguration({ ...baseEnv, PORT: port }), /PORT/);
  }
});

test("HTTP settings use the public endpoint and bearer token", () => {
  assert.deepEqual(
    httpClientConfiguration(
      httpConfiguration({ ...baseEnv, WOW_MCP_PUBLIC_URL: publicOrigin }),
    ),
    {
      mcpServers: {
        "wow-addon": {
          url: `${publicOrigin}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
  );
  const result = spawnSync(process.execPath, [configEntry], {
    encoding: "utf8",
    env: { ...process.env, ...baseEnv, WOW_MCP_PUBLIC_URL: publicOrigin },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    JSON.parse(result.stdout).mcpServers["wow-addon"].url,
    `${publicOrigin}/mcp`,
  );
});

test("invalid HTTP startup and configuration fail without printing secrets or JSON", () => {
  for (const script of [entry, configEntry]) {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, WOW_MCP_TOKEN: "short-private-secret" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /WOW_MCP_TOKEN/);
    assert.doesNotMatch(result.stderr, /short-private-secret/);
  }
});

describe("Streamable HTTP over Bun", { timeout: 15_000 }, () => {
  let child;
  let root;
  let endpoint;
  let stdout = "";
  let stderr = "";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wow-http-"));
    const data = join(root, "annotations/Annotations/Core/Data");
    const api = join(
      root,
      "annotations/Annotations/Core/Blizzard_APIDocumentationGenerated",
    );
    const source = join(root, "framexml/live/Annotations/AddOns/Test");
    await Promise.all(
      [data, api, source].map((directory) => mkdir(directory, { recursive: true })),
    );
    await Promise.all([
      writeFile(
        join(data, "Event.lua"),
        '---|"PLAYER_LOGIN"\n---|"PLAYER_LOGOUT" # `reason`\n',
      ),
      writeFile(
        join(api, "Item.lua"),
        "---@return string name\nfunction C_Item.GetItemInfo(itemID) end\n",
      ),
      writeFile(
        join(source, "Main.lua.annotated.lua"),
        "function HttpFixtureFunction() end\n",
      ),
    ]);
    child = spawn(process.execPath, [entry], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        ...baseEnv,
        WOW_MCP_MANAGE_ANNOTATIONS: "false",
        PORT: "0",
        WOW_MCP_HOST: "127.0.0.1",
        WOW_MCP_PUBLIC_URL: publicOrigin,
        WOW_ANNOTATIONS_ROOT: join(root, "annotations"),
        WOW_FRAMEXML_ROOT: join(root, "framexml"),
        WOW_RG_COMMAND: "rg",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`HTTP startup timed out: ${stderr}`)),
        5000,
      );
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`HTTP exited with ${code}: ${stderr}`));
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = /listening on (http:\/\/[^\s]+\/mcp)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
  });

  after(async () => {
    try {
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const [code] = await exited;
        assert.equal(code, 0, stderr);
      }
      assert.equal(stdout, "");
      assert.ok(!stderr.includes(token), "HTTP logs must not contain the bearer token");
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  function request(
    method = "POST",
    headers = {},
    body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  ) {
    return fetch(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      ...(method === "POST" && { body }),
    });
  }

  test("health is public and unknown routes do not expose data", async () => {
    const health = await fetch(new URL("/health", endpoint));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    const head = await fetch(new URL("/health", endpoint), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const missing = await fetch(new URL("/", endpoint));
    assert.equal(missing.status, 404);
  });

  test("every MCP method requires authentication", async () => {
    for (const method of ["POST", "GET", "DELETE", "OPTIONS"]) {
      for (const authorization of ["", "Bearer wrong-token", `Basic ${token}`]) {
        const response = await request(method, { Authorization: authorization });
        assert.equal(response.status, 401);
        assert.match(response.headers.get("www-authenticate"), /^Bearer /);
        assert.ok(!(await response.text()).includes(token));
      }
    }
    const lowercase = await request("POST", { Authorization: `bearer ${token}` });
    assert.equal(lowercase.status, 200);
    await lowercase.text();
  });

  test("unexpected hosts and origins are rejected before MCP dispatch", async () => {
    for (const headers of [
      { Host: "attacker.example" },
      { Origin: "https://attacker.example" },
      { Origin: "null" },
      { Origin: "http://wow-mcp.example.test" },
    ]) {
      const response = await request("POST", headers);
      assert.equal(response.status, 403);
    }
    const allowed = await request("POST", {
      Origin: publicOrigin,
      Host: "wow-mcp.example.test",
    });
    assert.equal(allowed.status, 200);
    await allowed.text();
  });

  test("stateless HTTP rejects standalone streams and oversized or invalid bodies", async () => {
    for (const method of ["GET", "DELETE"])
      assert.equal((await request(method)).status, 405);
    assert.equal((await request("POST", {}, "{")).status, 400);
    assert.equal((await request("POST", {}, "x".repeat(1024 * 1024 + 1))).status, 413);
    assert.equal((await fetch(new URL("/health", endpoint))).status, 200);
  });

  test("file updates become visible to the running MCP server", async () => {
    await writeFile(
      join(root, "annotations/Annotations/Core/Data/Event.lua"),
      '---|"PLAYER_LOGIN"\n---|"UPDATED_EVENT"\n',
    );
    const client = new Client({ name: "refresh-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "wow-event-info",
        arguments: { event: "UPDATED_EVENT" },
      });
      assert.notEqual(result.isError, true);
      assert.ok(JSON.stringify(result).includes("UPDATED_EVENT"));
    } finally {
      await client.close();
      await transport.close();
    }
  });

  for (const version of ["2026-07-28", "2025-11-25"]) {
    test(`MCP ${version} lists and calls the same four tools over SSE`, async () => {
      const contentTypes = [];
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (response.ok) contentTypes.push(response.headers.get("content-type"));
          return response;
        },
      });
      const client = new Client(
        { name: "wow-http-test", version: "1.0.0" },
        {
          supportedProtocolVersions: [version],
          versionNegotiation: {
            mode: version === "2025-11-25" ? "legacy" : { pin: version },
          },
        },
      );
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
          "wow-api-lookup",
          "wow-blizzard-source",
          "wow-event-info",
          "wow-wiki-fetch",
        ]);
        const calls = [
          { name: "wow-event-info", arguments: { event: "PLAYER_LOGIN" } },
          { name: "wow-api-lookup", arguments: { query: "C_Item.GetItemInfo" } },
          {
            name: "wow-blizzard-source",
            arguments: { pattern: "HttpFixtureFunction" },
          },
        ];
        const results = await Promise.all(calls.map((call) => client.callTool(call)));
        for (const [index, result] of results.entries()) {
          assert.notEqual(result.isError, true, JSON.stringify(result));
          const expected = Object.values(calls[index].arguments)[0];
          assert.ok(JSON.stringify(result).includes(expected));
        }
        assert.ok(contentTypes.some((value) => value?.includes("text/event-stream")));
      } finally {
        await client.close();
        await transport.close();
      }
    });
  }
});
