// Responsibility: ask a running example Worker for its limits table and for
// four json_each sizes, on D1 and on the Durable Object, and print one table.
// Boundary: it asserts no platform value; it stops a target when a setup
// step fails, and keeps the other target's rows.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Target = "d1" | "do";
export type Send = (target: Target, body: unknown) => Promise<{ status: number; text: string }>;
export type LimitRow = { probe: string; d1: string; do: string };

// The Cloudflare docs pages state 2 MB for a value; workerd's source sets
// 4 MiB in the pinned release. 1.9 MB and 2.1 MB sit on either side of the
// documented number. Only the smallest size goes through a command, so a
// run writes about 1,800 rows to each store; the others go through a read.
export const JSON_EACH_BYTES = { place: 150_000, ordersByIds: [1_000_000, 1_900_000, 2_100_000] };

// A UUID id, the shape newId() returns, makes a line 82 bytes, so the row
// count reads as rows per command for such lines.
function linesOf(bytes: number): { id: string; sku: string; qty: number; price: number }[] {
  const line = () => ({ id: crypto.randomUUID(), sku: "sku-0001", qty: 1, price: 1.5 });
  return Array.from({ length: Math.max(1, Math.round(bytes / (JSON.stringify(line()).length + 1))) }, line);
}

function idsOf(bytes: number): string[] {
  return Array.from({ length: Math.max(1, Math.round(bytes / (JSON.stringify(crypto.randomUUID()).length + 1))) }, () => crypto.randomUUID());
}

// A reply that is not the Worker's JSON, such as a Cloudflare error page for
// a CPU or request-size limit, keeps its status and text, so the row is not
// read as a SQLite limit. A command returns its own result inside `value`,
// and a failed one (a constraint, for example) has ok: false there.
async function outcome(send: Send, target: Target, body: unknown): Promise<{ result: string; value?: unknown }> {
  let reply: { status: number; text: string };
  try {
    reply = await send(target, body);
  } catch (e) {
    return { result: `the request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  let parsed: { ok: boolean; value?: unknown; message?: string };
  try {
    parsed = JSON.parse(reply.text) as typeof parsed;
  } catch {
    return { result: `HTTP ${reply.status}: ${reply.text.slice(0, 200)}` };
  }
  if (reply.status !== 200) return { result: `HTTP ${reply.status}: ${reply.text.slice(0, 200)}` };
  if (!parsed.ok) return { result: parsed.message ?? "failed without a message" };
  const value = parsed.value as { ok?: unknown } | null | undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value) && value.ok === false) return { result: `the command failed: ${JSON.stringify(value).slice(0, 200)}` };
  return { result: "pass", value: parsed.value };
}

async function setUp(send: Send, target: Target, body: { step: string } & Record<string, unknown>): Promise<void> {
  const done = await outcome(send, target, body);
  if (done.result !== "pass") throw new Error(`${target}: the ${body.step} step failed: ${done.result}`);
}

async function targetLimits(send: Send, target: Target, sizes: typeof JSON_EACH_BYTES): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const limits = await outcome(send, target, { step: "limits" });
  // A Worker deployed before the limits step answers it with ok and no value.
  if (limits.result === "pass" && !Array.isArray(limits.value)) throw new Error(`${target}: the Worker answered the limits step with no table; redeploy the example Worker so it has the step.`);
  if (limits.result !== "pass") throw new Error(`${target}: the limits step failed: ${limits.result}`);
  for (const probe of limits.value as { name: string; result: string }[]) results.set(probe.name, probe.result);
  const run = crypto.randomUUID();
  const customer = `limits-${run}`;
  await setUp(send, target, { step: "reset" });
  await setUp(send, target, { step: "createCustomer", id: customer, name: "Limits", email: `${customer}@example.com` });
  const lines = linesOf(sizes.place);
  const placed = await outcome(send, target, { step: "placeOrder", id: `order-${run}`, customer_id: customer, lines });
  results.set(`place over ${bytesOf(lines)} of lines (${count(lines.length)} rows)`, placed.result);
  for (const bytes of sizes.ordersByIds) {
    const ids = idsOf(bytes);
    const read = await outcome(send, target, { step: "ordersByIds", ids });
    results.set(`ordersByIds over ${bytesOf(ids)} of ids (${count(ids.length)} ids)`, read.result);
  }
  const cleared = await outcome(send, target, { step: "reset" });
  if (cleared.result !== "pass") results.set("reset after the run", cleared.result);
  return results;
}

const count = (n: number) => n.toLocaleString("en-US");
const bytesOf = (value: unknown[]) => `${count(JSON.stringify(value).length)} bytes`;

export async function deployedLimits(send: Send, sizes: typeof JSON_EACH_BYTES = JSON_EACH_BYTES): Promise<LimitRow[]> {
  const stopped = (e: unknown) => e instanceof Error ? e.message : String(e);
  const d1 = await targetLimits(send, "d1", sizes).catch(stopped);
  const durableObject = await targetLimits(send, "do", sizes).catch(stopped);
  if (typeof d1 === "string" && typeof durableObject === "string") throw new Error(`${d1} ${durableObject}`);
  const cell = (results: Map<string, string> | string, probe: string) => typeof results === "string" ? results : results.get(probe) ?? "missing";
  const probes = new Set([...(typeof d1 === "string" ? [] : d1.keys()), ...(typeof durableObject === "string" ? [] : durableObject.keys())]);
  return [...probes].map((probe) => ({ probe, d1: cell(d1, probe), do: cell(durableObject, probe) }));
}

export function markdownTable(rows: readonly LimitRow[]): string {
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  return ["| probe | D1 | Durable Object |", "|---|---|---|", ...rows.map((r) => `| ${cell(r.probe)} | ${cell(r.d1)} | ${cell(r.do)} |`)].join("\n");
}

export function fetchSend(url: string, token: string | undefined): Send {
  return async (target, body) => {
    const response = await fetch(new URL(target === "do" ? "/do" : "/", url), {
      method: "POST",
      body: JSON.stringify(body),
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: response.status, text: await response.text() };
  };
}

async function main(): Promise<void> {
  const url = process.env.SOLARSQL_REMOTE_URL;
  if (url === undefined) throw new Error("Set SOLARSQL_REMOTE_URL to the deployed example Worker's URL.");
  const rows = await deployedLimits(fetchSend(url, process.env.SOLARSQL_REMOTE_TOKEN));
  console.log(`Measured ${new Date().toISOString()}. Workers plan: ${process.env.SOLARSQL_WORKERS_PLAN ?? "not given (set SOLARSQL_WORKERS_PLAN)"}.\n`);
  console.log(markdownTable(rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
