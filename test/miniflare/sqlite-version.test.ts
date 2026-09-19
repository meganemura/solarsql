// Responsibility: compare the SQLite version node:sqlite reports at build
// time (src/build/facts.ts's Engine runs on it) against the version workerd
// reports on D1 and on a Durable Object, so a drift between the two engines
// is caught here instead of showing up as a build that passes locally and a
// deploy that rejects syntax the build accepted. A bare `select
// sqlite_version()` is itself outside workerd's function allowlist (ADR
// 0113; test/miniflare/function-allowlist.test.ts pins the refusal), so
// this reads it the way ADR 0114 already reads it there: through a column
// DEFAULT expression, which both engines still evaluate.
// Boundary: reports what one local Miniflare version sees. A real Cloudflare
// deploy is not exercised here (see skills/solarsql/references/deploy.md's
// remote suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { D1Harness, type WorkerOk } from "../d1.ts";

function majorMinor(version: string): string {
  const m = /^(\d+\.\d+)\./.exec(version);
  if (!m) throw new Error(`not a version string: ${version}`);
  return m[1]!;
}

async function d1SqliteVersion(): Promise<string> {
  const d1 = new D1Harness();
  try {
    const batchReply = await d1.batch([
      { sql: "create table v (id text primary key not null, a text default (sqlite_version()))" },
      { sql: "insert into v (id) values ('x')" },
    ]);
    assert.equal(batchReply.ok, true, JSON.stringify(batchReply));
    const reply = await d1.all("select a from v");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const rows = ((reply as WorkerOk).results as { results: Record<string, unknown>[] }).results;
    return rows[0]!.a as string;
  } finally {
    await d1.dispose();
  }
}

const durableObjectScript = `
import { DurableObject } from "cloudflare:workers";
export class VersionProbe extends DurableObject {
  async fetch() {
    const s = this.ctx.storage.sql;
    s.exec("create table v (id text primary key not null, a text default (sqlite_version()))");
    s.exec("insert into v (id) values ('x')");
    const rows = s.exec("select a from v").toArray();
    return Response.json({ v: rows[0].a });
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
    script: durableObjectScript,
    compatibilityDate: "2026-08-28",
    durableObjects: { PROBE: { className: "VersionProbe", useSQLite: true } },
  }));
  try {
    const response = await mf.dispatchFetch("http://localhost/");
    const body = (await response.json()) as { v: string };
    return body.v;
  } finally {
    await mf.dispose();
  }
}

test("node:sqlite, D1, and a Durable Object report the same major.minor SQLite version", async () => {
  const nodeVersion = new DatabaseSync(":memory:").prepare("select sqlite_version() as v").get()!.v as string;
  const [d1Version, doVersion] = await Promise.all([d1SqliteVersion(), durableObjectSqliteVersion()]);

  console.log(`sqlite versions: node:sqlite=${nodeVersion} D1=${d1Version} DurableObject=${doVersion}`);

  assert.equal(d1Version, doVersion, "D1 and a Durable Object should share workerd's one SQLite build");
  assert.equal(
    majorMinor(nodeVersion),
    majorMinor(d1Version),
    `node:sqlite (${nodeVersion}) and workerd (${d1Version}) have diverged past a patch version`,
  );
});
