// Responsibility: exercise kind "foreign_key" (src/runtime/plan.ts's
// constraintFailure()) through a real db.run() on each adapter. Every other
// CommandResult failure kind already runs through node:sqlite, D1, or a
// Durable Object in test/miniflare/failure.test.ts and test/node.test.ts;
// "foreign_key" was proven only by feeding a hand-written message to
// constraintFailure() directly. This fixture inserts a child row whose
// parent is missing and reads the actual CommandResult back.
// Boundary: local Miniflare evidence for D1 and a Durable Object; a real
// Cloudflare deployment is not exercised here (see
// skills/solarsql/references/deploy.md's remote suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { loadWorkerModules } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

const DDL = "create table parent (id text primary key not null) strict;" +
  "create table child (id text primary key not null, parent_id text not null references parent(id)) strict";
// Named-parameter form: the same statement the generated command runs.
const INSERT = "insert into child (id, parent_id) values (:id, :parent_id)";
// Positional form, run outside any adapter, to capture the engine's own
// unclassified message for the report.
const RAW_INSERT = "insert into child (id, parent_id) values (?, ?)";

const generated = { [INSERT]: { params: ["id", "parent_id"], encode: [], json: [], reads: [] } };

test("node:sqlite reports kind foreign_key on a real db.run()", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { node } = await import("../../src/node.ts");
  const { commands } = await import("../../src/index.ts");
  const command = commands(generated, { create: { plan: [INSERT] } }).create;

  const raw = new DatabaseSync(":memory:");
  try {
    // node:sqlite defaults foreign_keys off; D1 and a Durable Object do not
    // need this pragma (both enforce foreign keys by default).
    raw.exec("pragma foreign_keys = on");
    raw.exec(DDL);
    let message: string | null = null;
    try {
      raw.prepare(RAW_INSERT).run("raw-node", "missing");
      assert.fail("Expected the raw insert to violate the foreign key");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    console.log(`node:sqlite raw foreign key message: ${message}`);

    const db = node(raw);
    const result = await db.run(command, { id: "c1", parent_id: "missing" } as never);
    assert.deepEqual(result, { ok: false, kind: "foreign_key" });
  } finally {
    raw.close();
  }
});

test("D1 and a Durable Object report kind foreign_key on a real db.run()", async (t) => {
  // The virtual entry imports the library's own d1() and durable() adapters
  // and the command they run, so this proves the adapters' classification,
  // not a re-implementation of it in a worker script. No file backs this
  // module: its declared path only makes its relative imports resolve
  // against the real src/ modules that loadWorkerModules() reads from disk.
  const entryPath = "test/miniflare/foreign-key-kind.worker.ts";
  const entry = `
import { d1 } from "../../src/d1.ts";
import { durable } from "../../src/durable.ts";
import { commands } from "../../src/index.ts";
import { DurableObject } from "cloudflare:workers";

const DDL = ${JSON.stringify(DDL)};
const INSERT = ${JSON.stringify(INSERT)};
const RAW_INSERT = ${JSON.stringify(RAW_INSERT)};
const generated = { [INSERT]: { params: ["id", "parent_id"], encode: [], json: [], reads: [] } };
const command = commands(generated, { create: { plan: [INSERT] } }).create;

export class Probe extends DurableObject {
  async fetch() {
    this.ctx.storage.sql.exec(DDL);
    let message = null;
    try {
      this.ctx.storage.sql.exec(RAW_INSERT, "raw-do", "missing");
    } catch (e) {
      message = e && e.message ? e.message : String(e);
    }
    const result = await durable(this.ctx.storage).run(command, { id: "c1", parent_id: "missing" });
    return Response.json({ result, message });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/do") {
      const id = env.PROBE.idFromName("probe");
      return env.PROBE.get(id).fetch("http://do/");
    }
    await env.DB.exec(DDL);
    let message = null;
    try {
      await env.DB.prepare(RAW_INSERT).bind("raw-d1", "missing").run();
    } catch (e) {
      message = e && e.message ? e.message : String(e);
    }
    const result = await d1(env.DB).run(command, { id: "c1", parent_id: "missing" });
    return Response.json({ result, message });
  }
};
`;
  const modules = new Map(
    [
      ...loadWorkerModules(resolve(root, "src/d1.ts"), root),
      ...loadWorkerModules(resolve(root, "src/durable.ts"), root),
      // commands() is runtime code, unlike d1.ts's and durable.ts's own
      // type-only imports of index.ts, so the entry needs this module too.
      ...loadWorkerModules(resolve(root, "src/index.ts"), root),
    ].map((m) => [m.path, m] as const),
  );
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: root,
      modules: [{ type: "ESModule", path: entryPath, contents: entry }, ...modules.values()],
      compatibilityDate: "2026-08-28",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "example-db" },
      durableObjects: { PROBE: { className: "Probe", useSQLite: true } },
    }),
  );
  t.after(() => mf.dispose());

  const d1Response = (await (await mf.dispatchFetch("http://localhost/")).json()) as { result: unknown; message: string };
  console.log(`D1 raw foreign key message: ${d1Response.message}`);
  assert.deepEqual(d1Response.result, { ok: false, kind: "foreign_key" });

  const doResponse = (await (await mf.dispatchFetch("http://localhost/do")).json()) as { result: unknown; message: string };
  console.log(`Durable Object raw foreign key message: ${doResponse.message}`);
  assert.deepEqual(doResponse.result, { ok: false, kind: "foreign_key" });
});
