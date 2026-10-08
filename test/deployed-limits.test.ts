// Responsibility: the replies that spike/17-deployed-limits.ts must not read
// as a pass, fed through a fake send.
// Boundary: no Worker; test/miniflare/deployed-limits.test.ts runs the spike
// against the example Worker.
import { test } from "vitest";
import assert from "node:assert/strict";
import { deployedLimits, type Send } from "../spike/17-deployed-limits.ts";

const sizes = { place: 100, ordersByIds: [100] };
const json = (status: number, value: unknown) => ({ status, text: JSON.stringify(value) });
const table = { ok: true, value: [{ name: "5-term UNION ALL", result: "pass" }] };

test("a failed command inside a pass reply, an error page, and a rejected request keep their text", async () => {
  const send: Send = async (_target, body) => {
    const { step } = body as { step: string };
    if (step === "limits") return json(200, table);
    if (step === "placeOrder") return json(200, { ok: true, value: { ok: false, kind: "constraint", constraint: "order_lines.qty" } });
    if (step === "ordersByIds") throw new Error("fetch failed");
    return json(200, { ok: true, value: { ok: true } });
  };
  const rows = await deployedLimits(send, sizes);
  assert.deepEqual(rows.map((row) => row.d1), [
    "pass",
    'the command failed: {"ok":false,"kind":"constraint","constraint":"order_lines.qty"}',
    "the request failed: fetch failed",
  ]);
  const page: Send = async (_target, body) => (body as { step: string }).step === "ordersByIds" ? { status: 503, text: "<html>Error 1102</html>" } : send(_target, body);
  assert.equal((await deployedLimits(page, sizes))[2]!.do, "HTTP 503: <html>Error 1102</html>");
});

test("only a Worker that answers the limits step with no table is told to redeploy", async () => {
  await assert.rejects(deployedLimits(async () => json(200, { ok: true }), sizes),
    /^Error: d1: the Worker answered the limits step with no table; redeploy the example Worker so it has the step\. do: /);
  await assert.rejects(deployedLimits(async () => ({ status: 401, text: "unauthorized" }), sizes),
    (e: unknown) => e instanceof Error && e.message === "d1: the limits step failed: HTTP 401: unauthorized do: the limits step failed: HTTP 401: unauthorized");
});

test("a Durable Object that fails keeps D1's rows, and the failure fills its own column", async () => {
  const send: Send = async (target, body) => {
    if (target === "do") return { status: 500, text: "Internal Server Error" };
    const { step } = body as { step: string };
    return step === "limits" ? json(200, table) : json(200, { ok: true, value: step === "ordersByIds" ? [] : { ok: true } });
  };
  const rows = await deployedLimits(send, sizes);
  assert.deepEqual(rows.map((row) => [row.d1, row.do]), [
    ["pass", "do: the limits step failed: HTTP 500: Internal Server Error"],
    ["pass", "do: the limits step failed: HTTP 500: Internal Server Error"],
    ["pass", "do: the limits step failed: HTTP 500: Internal Server Error"],
  ]);
});
