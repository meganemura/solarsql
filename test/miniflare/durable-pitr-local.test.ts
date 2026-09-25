// Pins Miniflare's local point-in-time recovery (PITR) behavior: a bookmark
// pair the local Durable Object storage can compare, and the two calls that
// need a real deployment's durable log of data changes, refused locally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");
const bookmarkPattern = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/;

test("getCurrentBookmark() resolves to a counter-shaped bookmark, later strictly greater", async (t) => {
  const mf = workerMiniflare(resolve(root, "test/durable-pitr-local.worker.ts"), root, { durableObjects: { PROBE: "PitrProbe" } });
  t.after(() => mf.dispose());

  const response = await mf.dispatchFetch("http://localhost/two-bookmarks");
  const { first, second } = (await response.json()) as { first: string; second: string };

  assert.match(first, bookmarkPattern);
  assert.match(second, bookmarkPattern);
  assert.ok(second > first, `expected ${second} > ${first}`);
});

test("getBookmarkForTime() rejects locally: no durable log of data changes", async (t) => {
  const mf = workerMiniflare(resolve(root, "test/durable-pitr-local.worker.ts"), root, { durableObjects: { PROBE: "PitrProbe" } });
  t.after(() => mf.dispose());

  const response = await mf.dispatchFetch("http://localhost/get-bookmark-for-time");
  const { ok, message } = (await response.json()) as { ok: boolean; message?: string };

  assert.equal(ok, false);
  assert.ok(message?.includes("does not implement point-in-time recovery"), message ?? "");
});

test("onNextSessionRestoreBookmark() rejects locally: no durable log of data changes", async (t) => {
  const mf = workerMiniflare(resolve(root, "test/durable-pitr-local.worker.ts"), root, { durableObjects: { PROBE: "PitrProbe" } });
  t.after(() => mf.dispose());

  const response = await mf.dispatchFetch("http://localhost/restore-bookmark");
  const { ok, message } = (await response.json()) as { ok: boolean; message?: string };

  assert.equal(ok, false);
  assert.ok(message?.includes("does not implement point-in-time recovery"), message ?? "");
});
