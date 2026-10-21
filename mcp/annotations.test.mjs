import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ANNOTATION_REFRESH_MS,
  createAnnotationMaintenance,
  runAnnotationMaintenance,
} from "../dist/mcp/annotations.js";
import { createHttpApplication, httpConfiguration } from "../dist/mcp/http.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "wow-annotations-"));
  const env = {
    ...process.env,
    WOW_MCP_MANAGE_ANNOTATIONS: "true",
    WOW_ANNOTATIONS_ROOT: join(root, "catalog"),
    WOW_FRAMEXML_ROOT: join(root, "framexml"),
  };
  const statePath = `${env.WOW_FRAMEXML_ROOT}.update.json`;
  const timers = new Set();
  const managers = [];
  const logs = [];
  let time = Date.UTC(2026, 9, 21);
  let runs = 0;

  async function populate() {
    const data = join(env.WOW_ANNOTATIONS_ROOT, "Annotations/Core/Data");
    const api = join(
      env.WOW_ANNOTATIONS_ROOT,
      "Annotations/Core/Blizzard_APIDocumentationGenerated",
    );
    const sources = ["live", "classic", "classic_era", "classic_anniversary"].map(
      (flavor) => join(env.WOW_FRAMEXML_ROOT, flavor, "Annotations"),
    );
    await Promise.all(
      [data, api, ...sources].map((path) => mkdir(path, { recursive: true })),
    );
    await Promise.all([
      writeFile(join(data, "Event.lua"), '---|"PLAYER_LOGIN"\n'),
      writeFile(join(api, "Item.lua"), "function C_Item.GetItemInfo() end\n"),
      ...sources.map((path) =>
        writeFile(join(path, "Main.lua.annotated.lua"), "function Fixture() end\n"),
      ),
    ]);
  }

  function manager(overrides = {}) {
    const instance = createAnnotationMaintenance({
      env,
      now: () => time,
      run: async () => {
        runs++;
        await populate();
      },
      schedule(callback, delay) {
        const timer = { callback, delay, unref() {} };
        timers.add(timer);
        return timer;
      },
      cancel: (timer) => timers.delete(timer),
      log: (message) => logs.push(message),
      ...overrides,
    });
    managers.push(instance);
    return instance;
  }

  t.after(async () => {
    await Promise.all(managers.map((instance) => instance.stop()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    env,
    root,
    statePath,
    populate,
    manager,
    timers,
    logs,
    runs: () => runs,
    now: () => time,
    advance: (milliseconds) => {
      time += milliseconds;
    },
    state: async (lastSuccess) =>
      writeFile(
        statePath,
        JSON.stringify({
          annotationsRoot: env.WOW_ANNOTATIONS_ROOT,
          frameXmlRoot: env.WOW_FRAMEXML_ROOT,
          lastSuccess,
        }),
      ),
    async tick(instance) {
      const [timer] = timers;
      assert.ok(timer, "a refresh must be scheduled");
      timers.delete(timer);
      time += timer.delay;
      timer.callback();
      await instance.refresh();
    },
  };
}

test("empty storage downloads every data set before becoming ready", async (t) => {
  const f = await fixture(t);
  const manager = f.manager();
  assert.equal(manager.status().ready, false);
  await manager.start();
  await manager.refresh();
  assert.equal(f.runs(), 1);
  assert.deepEqual(manager.status(), {
    ready: true,
    updating: false,
    lastSuccess: f.now(),
    updateFailed: false,
  });
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).lastSuccess, f.now());
  assert.equal([...f.timers][0].delay, ANNOTATION_REFRESH_MS);
});

test("a running process refreshes again after one day", async (t) => {
  const f = await fixture(t);
  const manager = f.manager();
  await manager.start();
  await manager.refresh();
  const firstSuccess = manager.status().lastSuccess;
  await f.tick(manager);
  assert.equal(f.runs(), 2);
  assert.equal(manager.status().lastSuccess - firstSuccess, 24 * 60 * 60 * 1000);
  assert.equal(f.timers.size, 1);
});

test("warm restarts reuse data and the persisted daily refresh deadline", async (t) => {
  const f = await fixture(t);
  const first = f.manager();
  await first.start();
  await first.refresh();
  await first.stop();
  f.advance(6 * 60 * 60 * 1000);
  const restarted = f.manager();
  await restarted.start();
  assert.equal(restarted.status().ready, true);
  assert.equal(f.runs(), 1);
  assert.equal([...f.timers][0].delay, 18 * 60 * 60 * 1000);
  await f.tick(restarted);
  assert.equal(f.runs(), 2);
});

test("overdue data refreshes on startup while local lookups remain available", async (t) => {
  const f = await fixture(t);
  await f.populate();
  await f.state(f.now() - 2 * ANNOTATION_REFRESH_MS);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const manager = f.manager({ run: () => pending });
  await manager.start();
  assert.equal(manager.status().ready, true);
  assert.equal(manager.status().updating, true);
  const first = manager.refresh();
  assert.equal(
    first,
    manager.refresh(),
    "concurrent requests must share one maintenance run",
  );
  release();
  await first;
  assert.equal(manager.status().lastSuccess, f.now());
});

test("failed updates keep existing data and the successful timestamp, then retry", async (t) => {
  const f = await fixture(t);
  await f.populate();
  const lastSuccess = f.now() - 2 * ANNOTATION_REFRESH_MS;
  await f.state(lastSuccess);
  let fail = true;
  const manager = f.manager({
    run: async () => {
      if (fail) throw new Error("network unavailable");
    },
  });
  await manager.start();
  await manager.refresh();
  assert.equal(manager.status().ready, true);
  assert.equal(manager.status().updateFailed, true);
  assert.equal(manager.status().lastSuccess, lastSuccess);
  assert.equal(
    JSON.parse(await readFile(f.statePath, "utf8")).lastSuccess,
    lastSuccess,
  );
  assert.equal([...f.timers][0].delay, 60 * 60 * 1000);
  fail = false;
  await f.tick(manager);
  assert.equal(manager.status().updateFailed, false);
  assert.equal(manager.status().lastSuccess, f.now());
});

test("an initial network failure stays unready and recovers on the scheduled retry", async (t) => {
  const f = await fixture(t);
  let fail = true;
  const manager = f.manager({
    run: async () => {
      if (fail) throw new Error("offline");
      await f.populate();
    },
  });
  await manager.start();
  await manager.refresh();
  assert.equal(manager.status().ready, false);
  assert.equal(existsSync(f.statePath), false);
  assert.equal([...f.timers][0].delay, 60 * 60 * 1000);
  fail = false;
  await f.tick(manager);
  assert.equal(manager.status().ready, true);
});

test("missing or empty catalogs force repair even with a recent saved timestamp", async (t) => {
  const f = await fixture(t);
  await f.populate();
  await f.state(f.now());
  await writeFile(
    join(f.env.WOW_ANNOTATIONS_ROOT, "Annotations/Core/Data/Event.lua"),
    "",
  );
  const manager = f.manager();
  await manager.start();
  await manager.refresh();
  assert.equal(f.runs(), 1);
  assert.equal(manager.status().ready, true);
});

test("incomplete maintenance results never mark empty storage ready", async (t) => {
  const f = await fixture(t);
  const manager = f.manager({ run: async () => {} });
  await manager.start();
  await manager.refresh();
  assert.equal(manager.status().ready, false);
  assert.equal(manager.status().updateFailed, true);
  assert.equal(existsSync(f.statePath), false);
});

test("corrupt or future timestamps cannot defer an update", async (t) => {
  const f = await fixture(t);
  await f.populate();
  for (const state of [
    "invalid-json",
    JSON.stringify({
      annotationsRoot: f.env.WOW_ANNOTATIONS_ROOT,
      frameXmlRoot: f.env.WOW_FRAMEXML_ROOT,
      lastSuccess: f.now() + ANNOTATION_REFRESH_MS,
    }),
  ]) {
    await writeFile(f.statePath, state);
    const manager = f.manager();
    await manager.start();
    await manager.refresh();
    assert.equal(manager.status().lastSuccess, f.now());
    await manager.stop();
  }
  assert.equal(f.runs(), 2);
});

test("shutdown cancels active maintenance and does not schedule another run", async (t) => {
  const f = await fixture(t);
  let aborted = false;
  const manager = f.manager({
    run: (_, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  await manager.start();
  await manager.stop();
  assert.equal(aborted, true);
  assert.equal(manager.status().updating, false);
  assert.equal(f.timers.size, 0);
  assert.equal(existsSync(f.statePath), false);
});

test("externally managed data can disable automatic writes and networking", async (t) => {
  const f = await fixture(t);
  const manager = f.manager({ env: { ...f.env, WOW_MCP_MANAGE_ANNOTATIONS: "false" } });
  await manager.start();
  await manager.refresh();
  assert.equal(f.runs(), 0);
  assert.equal(f.timers.size, 0);
  assert.equal(manager.status().ready, true);
  assert.equal(existsSync(f.statePath), false);
  assert.throws(
    () => f.manager({ env: { ...f.env, WOW_MCP_MANAGE_ANNOTATIONS: "maybe" } }),
    /must be true or false/,
  );
});

test("HTTP remains live but refuses MCP until annotation setup completes", async (t) => {
  const f = await fixture(t);
  const manager = f.manager();
  const token = "test-annotations-token-0123456789abcdef";
  const application = createHttpApplication(
    httpConfiguration({ WOW_MCP_TOKEN: token }),
    manager.status,
  );
  t.after(() => application.close());
  const request = (path, authorized = false) =>
    application.fetch(
      new Request(`http://localhost:3000${path}`, {
        headers: {
          Host: "localhost:3000",
          ...(authorized && { Authorization: `Bearer ${token}` }),
        },
      }),
    );
  assert.equal((await request("/health")).status, 200);
  assert.equal((await request("/ready")).status, 503);
  assert.equal((await request("/mcp")).status, 401);
  const waiting = await request("/mcp", true);
  assert.equal(waiting.status, 503);
  assert.equal(waiting.headers.get("retry-after"), "60");
  await manager.start();
  await manager.refresh();
  assert.equal((await request("/ready")).status, 200);
  assert.equal(
    (await (await request("/health")).json()).annotations.lastSuccess,
    f.now(),
  );
});

test("maintenance cancellation terminates the shell and its Git descendants", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await fixture(t);
  const bin = join(f.root, "bin");
  const marker = join(f.root, "started");
  await mkdir(bin);
  await writeFile(
    join(bin, "bash"),
    '#!/bin/sh\nprintf started > "$TEST_STARTED"\nsleep 300 &\nwait\n',
    { mode: 0o755 },
  );
  const controller = new AbortController();
  const pending = runAnnotationMaintenance(
    { ...f.env, PATH: `${bin}:${process.env.PATH}`, TEST_STARTED: marker },
    controller.signal,
  );
  const rejected = assert.rejects(pending, /test shutdown/);
  t.after(async () => {
    controller.abort(new Error("test shutdown"));
    await rejected;
  });
  const deadline = Date.now() + 3000;
  while (!existsSync(marker) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(marker));
  controller.abort(new Error("test shutdown"));
  await rejected;
});
