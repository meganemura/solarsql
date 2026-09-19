// Responsibility: prove empirically that Miniflare fires a Durable Object
// alarm and that the handler can run a solarsql command (durable()), for
// skills/solarsql/references/running.md's "On a Durable Object" section.
// No Miniflare test API sets off the alarm; workerd's own scheduler does,
// the same as a real deployment (this is the fact the section cites).
// Boundary: local Miniflare evidence; a real Cloudflare deployment is not
// exercised here (see skills/solarsql/references/deploy.md's remote suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

test("an alarm set from a request fires and its handler runs a command", async (t) => {
  const mf = workerMiniflare(resolve(root, "test/durable-alarm.worker.ts"), root, { durableObjects: { PROBE: "AlarmProbe" } });
  t.after(() => mf.dispose());

  const scheduled = await mf.dispatchFetch("http://localhost/");
  assert.equal(await scheduled.text(), "scheduled");

  const deadline = Date.now() + 2000;
  let found = false;
  while (Date.now() < deadline) {
    const response = await mf.dispatchFetch("http://localhost/check");
    ({ found } = (await response.json()) as { found: boolean });
    if (found) break;
  }

  assert.equal(found, true, "the alarm handler's command never inserted the row within 2 seconds");
});
