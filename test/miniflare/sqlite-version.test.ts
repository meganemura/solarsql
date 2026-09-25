// Responsibility: compares node:sqlite, D1, and a Durable Object's own
// SQLite by the values three probe statements return, not by a version
// string. This file previously compared the three by major.minor version
// string; that comparison is replaced here, because two SQLite builds
// sharing a major.minor were measured returning different values for the
// same expression (json_array(0.1 + 0.2): '[0.3]' on 3.53.0/3.53.1, and
// '[0.30000000000000004]' on 3.53.3/3.53.4 and on workerd 1.20260828.1's
// SQLite 3.53.4 -- a patch-level change sqlite.org/changes.html does not
// list). ADR 0014's premise is that the local engine is the production
// engine; a value differential tests that premise directly, where a
// major.minor comparison only tested a proxy for it.
// A bare `select sqlite_version()` is itself outside workerd's function
// allowlist (ADR 0113; test/miniflare/function-allowlist.test.ts pins the
// refusal), so the version print still reads it the way ADR 0114 already
// reads it here: through a column DEFAULT expression, which both engines
// still evaluate. That probe can itself fail should workerd's own
// call-authorizer-in-default-column-expressions patch (0006) change which
// DEFAULT expressions it reaches; the version print tolerates that failure
// and prints "unavailable" rather than failing the file.
// Boundary: reports what one local Miniflare version sees. A real Cloudflare
// deploy is not exercised here (see skills/solarsql/references/deploy.md's
// remote suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { D1Harness, type WorkerOk } from "../d1.ts";
import { WORKERD_SQLITE_VERSION } from "../../src/build/facts.ts";

async function d1SqliteVersion(): Promise<string> {
  const d1 = new D1Harness();
  try {
    const batchReply = await d1.batch([
      { sql: "create table v (id text primary key not null, a text default (sqlite_version()))" },
      { sql: "insert into v (id) values ('x')" },
    ]);
    if (!batchReply.ok) return "unavailable";
    const reply = await d1.all("select a from v");
    if (!reply.ok) return "unavailable";
    const rows = ((reply as WorkerOk).results as { results: Record<string, unknown>[] }).results;
    return (rows[0]?.a as string) ?? "unavailable";
  } catch {
    return "unavailable";
  } finally {
    await d1.dispose();
  }
}

const durableObjectVersionScript = `
import { DurableObject } from "cloudflare:workers";
export class VersionProbe extends DurableObject {
  async fetch() {
    const s = this.ctx.storage.sql;
    try {
      s.exec("create table v (id text primary key not null, a text default (sqlite_version()))");
      s.exec("insert into v (id) values ('x')");
      const rows = s.exec("select a from v").toArray();
      return Response.json({ v: rows[0].a });
    } catch (e) {
      return Response.json({ v: "unavailable" });
    }
  }
}
export default {
  async fetch(request, env) {
    const id = env.PROBE.idFromName("version-probe");
    return env.PROBE.get(id).fetch("http://do/");
  },
};
`;

async function durableObjectSqliteVersion(): Promise<string> {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: durableObjectVersionScript,
    compatibilityDate: "2026-08-28",
    durableObjects: { PROBE: { className: "VersionProbe", useSQLite: true } },
  }));
  try {
    const response = await mf.dispatchFetch("http://localhost/");
    const body = (await response.json()) as { v: string };
    return body.v;
  } catch {
    return "unavailable";
  } finally {
    await mf.dispose();
  }
}

test("node:sqlite, D1, and a Durable Object each report the pinned WORKERD_SQLITE_VERSION", async () => {
  const nodeVersion = new DatabaseSync(":memory:").prepare("select sqlite_version() as v").get()!.v as string;
  const [d1Version, doVersion] = await Promise.all([d1SqliteVersion(), durableObjectSqliteVersion()]);
  console.log(`sqlite versions: node:sqlite=${nodeVersion} D1=${d1Version} DurableObject=${doVersion}`);
  // A miniflare bump moves D1's and the Durable Object's own SQLite without
  // moving this constant; this assertion is what catches that drift, so it
  // must fail loudly (not skip) when the DEFAULT-expression probe itself
  // stops answering (workerd's call-authorizer patch 0006 could break it,
  // ADR 0114): "unavailable" fails the equality below the same as a wrong
  // version does, and the message tells a reader which case it is.
  const mismatch = (label: string, v: string) =>
    `${label} reported "${v}", not the pinned WORKERD_SQLITE_VERSION "${WORKERD_SQLITE_VERSION}". If the probe itself stopped answering, fix the probe; otherwise follow docs/releasing.md's MODULE.bazel step and update the constant.`;
  assert.equal(nodeVersion, WORKERD_SQLITE_VERSION, mismatch("node:sqlite", nodeVersion));
  assert.equal(d1Version, WORKERD_SQLITE_VERSION, mismatch("D1", d1Version));
  assert.equal(doVersion, WORKERD_SQLITE_VERSION, mismatch("the Durable Object", doVersion));
});

// Each probe below is a value two SQLite builds sharing a major.minor were
// measured returning differently (see the file header). node:sqlite runs it
// directly; D1 and the Durable Object run it through the harnesses in this
// file. All three must agree for the differential to hold.
function nodeValueProbe(sql: string): unknown {
  return new DatabaseSync(":memory:").prepare(sql).get();
}

async function d1ValueProbe(sql: string): Promise<unknown> {
  const d1 = new D1Harness();
  try {
    const reply = await d1.first(sql);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return (reply as WorkerOk).results;
  } finally {
    await d1.dispose();
  }
}

const durableObjectValueProbeScript = `
import { DurableObject } from "cloudflare:workers";
export class ValueProbe extends DurableObject {
  async fetch(request) {
    const { sql } = await request.json();
    const rows = this.ctx.storage.sql.exec(sql).toArray();
    return Response.json(rows[0]);
  }
}
export default {
  async fetch(request, env) {
    const id = env.PROBE.idFromName("value-probe");
    return env.PROBE.get(id).fetch("http://do/", { method: "POST", body: await request.text() });
  },
};
`;

async function durableObjectValueProbe(sql: string): Promise<unknown> {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: durableObjectValueProbeScript,
    compatibilityDate: "2026-08-28",
    durableObjects: { PROBE: { className: "ValueProbe", useSQLite: true } },
  }));
  try {
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ sql }) });
    return await response.json();
  } finally {
    await mf.dispose();
  }
}

const valueProbes = [
  "select json_array(0.1 + 0.2) as a, json_object('x', 1.0/3) as b",
  "select cast(0.1 + 0.2 as text) as a, cast(1e22/3 as text) as b",
];

for (const sql of valueProbes) {
  test(`node:sqlite, D1, and a Durable Object agree on: ${sql}`, async () => {
    const node = nodeValueProbe(sql);
    const [d1, durableObject] = await Promise.all([d1ValueProbe(sql), durableObjectValueProbe(sql)]);
    // Round-tripped through JSON on both sides: D1's own row objects carry a
    // null prototype, which deepEqual treats as a different shape from a
    // plain object even when every own property matches.
    const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
    assert.deepEqual(plain(d1), plain(node), `D1 (${JSON.stringify(d1)}) disagrees with node:sqlite (${JSON.stringify(node)})`);
    assert.deepEqual(plain(durableObject), plain(node), `the Durable Object (${JSON.stringify(durableObject)}) disagrees with node:sqlite (${JSON.stringify(node)})`);
  });
}

// A STRICT generated column's type refusal names the SQLite build's own
// storage-class check; D1 appends its own error class after the same
// prefix (ADR 0113's own pattern for a message comparison across engines).
const strictRefusalDdl = "create table g (id integer primary key, a text, b integer as (a) stored) strict";
const strictRefusalInsert = "insert into g (id, a) values (1, 'abc')";
const strictRefusalPrefix = "cannot store TEXT value in INTEGER column g.b";

function nodeStrictRefusal(): string {
  const db = new DatabaseSync(":memory:");
  db.exec(strictRefusalDdl);
  try {
    db.exec(strictRefusalInsert);
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
}

async function d1StrictRefusal(): Promise<string> {
  const d1 = new D1Harness();
  try {
    const ddl = await d1.exec(strictRefusalDdl);
    assert.equal(ddl.ok, true, JSON.stringify(ddl));
    const reply = await d1.run(strictRefusalInsert);
    return reply.ok ? "no error" : (reply as { message: string }).message;
  } finally {
    await d1.dispose();
  }
}

const durableObjectStrictRefusalScript = `
import { DurableObject } from "cloudflare:workers";
export class StrictRefusalProbe extends DurableObject {
  async fetch() {
    const s = this.ctx.storage.sql;
    s.exec(${JSON.stringify(strictRefusalDdl)});
    try {
      s.exec(${JSON.stringify(strictRefusalInsert)});
      return Response.json({ message: "no error" });
    } catch (e) {
      return Response.json({ message: e.message });
    }
  }
}
export default {
  async fetch(request, env) {
    const id = env.PROBE.idFromName("strict-refusal-probe");
    return env.PROBE.get(id).fetch("http://do/");
  },
};
`;

async function durableObjectStrictRefusal(): Promise<string> {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: durableObjectStrictRefusalScript,
    compatibilityDate: "2026-08-28",
    durableObjects: { PROBE: { className: "StrictRefusalProbe", useSQLite: true } },
  }));
  try {
    const response = await mf.dispatchFetch("http://localhost/");
    const body = (await response.json()) as { message: string };
    return body.message;
  } finally {
    await mf.dispose();
  }
}

test("node:sqlite, D1, and a Durable Object all refuse the same STRICT type mismatch, up to each engine's own error-class suffix", async () => {
  // node:sqlite gives the prefix with no wrapping; D1 prepends "D1_ERROR: "
  // and appends its own SQLITE_CONSTRAINT text, and this Miniflare
  // version's Durable Object appends the same SQLITE_CONSTRAINT text
  // without D1's prefix. The shared prefix text is the fact under test, so
  // every engine is compared by whether its message contains it, not by
  // equality or by position.
  const node = nodeStrictRefusal();
  const [d1, durableObject] = await Promise.all([d1StrictRefusal(), durableObjectStrictRefusal()]);
  assert.ok(node.includes(strictRefusalPrefix), `node:sqlite's message does not carry the shared prefix: ${node}`);
  assert.ok(d1.includes(strictRefusalPrefix), `D1's message does not carry the shared prefix: ${d1}`);
  assert.ok(durableObject.includes(strictRefusalPrefix), `the Durable Object's message does not carry the shared prefix: ${durableObject}`);
});
