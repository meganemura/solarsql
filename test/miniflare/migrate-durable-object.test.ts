// Responsibility: prove migrate()'s deferred foreign-key check (src/durable.ts)
// against a real Durable Object under workerd (Miniflare), not only against
// Node's storageOf() shim (test/node.test.ts already covers that side).
// Boundary: local Miniflare evidence; a real Cloudflare deployment is not
// exercised here (see skills/solarsql/references/deploy.md's remote suite).
import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { diff, introspect, open, render } from "../../src/build/migration.ts";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

// Same shape test/node.test.ts's "a rebuild that violates a new foreign
// key..." test uses: f1 creates parent/child and an orphaned child row, f2
// adds the foreign key parent_id -> parent.id, which only fails at commit
// because SQLite defers a new foreign key's check.
const before = [`create table parent (id text primary key not null)`, `create table child (id text primary key not null, parent_id text)`];
const after = [`create table parent (id text primary key not null)`, `create table child (id text primary key not null, parent_id text references parent(id))`];
const initial = diff(introspect(open([])), introspect(open(before)));
if (initial.kind !== "ok") throw new Error(initial.reason);
const f1 = render(1, "initial", [...initial.statements, "insert into parent values ('p1')", "insert into child values ('c1', 'missing')"]);
const tightened = diff(introspect(open(before)), introspect(open(after)));
if (tightened.kind !== "ok") throw new Error(tightened.reason);
const f2 = render(2, "foreign_key", tightened.statements, tightened.rebuilds ?? []);
const originalChildSchema = introspect(open(before)).tables.get("child")!.sql;

test("migrate() rolls back only the violating file on a real Durable Object, and leaves the object usable", async () => {
  const mf = workerMiniflare(resolve(root, "test/migrate-durable-object.worker.ts"), root, { durableObjects: { PROBE: "MigrateProbe" } });
  onTestFinished(() => mf.dispose());
  const send = async (instance: string, files: { name: string; sql: string }[]) => {
    const response = await mf.dispatchFetch(`http://localhost/${instance}`, { method: "POST", body: JSON.stringify(files) });
    return { status: response.status, body: await response.json() as {
      ok: boolean; applied: string[]; message: string | null; isMigrationHistoryError: boolean;
      historyNames: string[]; childSchema: string | null; childRows: Record<string, unknown>[];
    } };
  };

  // A fresh, isolated instance, distinct from example/worker.ts's shared
  // "example" Store (this fixture is not that class at all).
  const instance = "deferred-fk-probe";

  const applyF1 = await send(instance, [{ name: f1.filename, sql: f1.sql }]);
  assert.equal(applyF1.status, 200);
  assert.deepEqual(applyF1.body.applied, [f1.filename]);
  assert.equal(applyF1.body.message, null);

  // The unfixed behavior returns normally from migrate() here (the platform
  // only discards the response and resets the object later, at the
  // request's own implicit commit), so a 200 with a structured JS error is
  // exactly what distinguishes the fix from that failure mode -- a real
  // Durable Object would otherwise never hand this back as a catchable
  // response at all.
  const applyF2 = await send(instance, [{ name: f1.filename, sql: f1.sql }, { name: f2.filename, sql: f2.sql }]);
  assert.equal(applyF2.status, 200);
  assert.equal(applyF2.body.ok, false);
  assert.match(applyF2.body.message ?? "", /FOREIGN KEY constraint failed/);
  assert.equal(applyF2.body.isMigrationHistoryError, false);
  // f1's history row and schema change are retained; only f2 rolled back.
  assert.deepEqual(applyF2.body.historyNames, [f1.filename]);
  assert.equal(applyF2.body.childSchema, originalChildSchema);
  assert.deepEqual(applyF2.body.childRows, [{ id: "c1", parent_id: "missing" }]);

  // The same instance answers a further request normally: it was not reset
  // or left mid-transaction by the failed migrate() call above.
  const again = await send(instance, [{ name: f1.filename, sql: f1.sql }]);
  assert.equal(again.status, 200);
  assert.equal(again.body.ok, true);
  assert.deepEqual(again.body.applied, []);
  assert.deepEqual(again.body.historyNames, [f1.filename]);

  // A different instance name starts with no history: proves the probe
  // above ran against an isolated object, not a shared one another test
  // (or another instance name) could have already touched.
  const isolated = await send("a-different-instance", []);
  assert.equal(isolated.status, 200);
  assert.deepEqual(isolated.body.historyNames, []);
});

// The two tests below inject a foreign-key violation directly into a fresh
// Durable Object's storage, bypassing migrate() entirely, the same way a raw
// write outside migrate() (or a row left over from before the
// pragma_foreign_key_check migrate() runs today existed) can. Both need
// unsafeGetDurableObjectStorage, which needs unsafeInspectDurableObjects on
// the Miniflare instance (test/worker.ts), so each builds its own instance
// rather than sharing the one above.
test("migrate() applies a file that repairs a pre-existing violation, then applies a later file normally, on a real Durable Object", async () => {
  const mf = workerMiniflare(resolve(root, "test/migrate-durable-object.worker.ts"), root, { durableObjects: { PROBE: "MigrateProbe" }, unsafeInspectDurableObjects: true });
  onTestFinished(() => mf.dispose());
  const send = async (instance: string, files: { name: string; sql: string }[]) => {
    const response = await mf.dispatchFetch(`http://localhost/${instance}`, { method: "POST", body: JSON.stringify(files) });
    return { status: response.status, body: await response.json() as {
      ok: boolean; applied: string[]; message: string | null; isMigrationHistoryError: boolean;
      historyNames: string[]; childSchema: string | null; childRows: Record<string, unknown>[];
    } };
  };

  const instance = "repair-file-probe";
  const handle = await mf.unsafeGetDurableObjectStorage("", "MigrateProbe", { name: instance });
  await handle.exec(`CREATE TABLE parent (id text primary key not null)`);
  await handle.exec(`CREATE TABLE child (id text primary key not null, parent_id text references parent(id))`);
  await handle.exec(`insert into parent values ('p1')`);
  await handle.exec(`pragma foreign_keys=off`);
  await handle.exec(`insert into child values ('c1', 'missing')`);
  await handle.exec(`pragma foreign_keys=on`);

  const repair = { name: "0001_repair.sql", sql: `delete from child where parent_id = 'missing';` };
  const unrelated = { name: "0002_unrelated.sql", sql: `create table unrelated (id text primary key not null);` };

  const applyRepair = await send(instance, [repair]);
  assert.equal(applyRepair.status, 200);
  assert.equal(applyRepair.body.ok, true);
  assert.deepEqual(applyRepair.body.applied, [repair.name]);
  assert.deepEqual(applyRepair.body.historyNames, [repair.name]);
  assert.deepEqual(applyRepair.body.childRows, []);

  // migrate() requires the full ordered history on every call, so the
  // second call resupplies the already-applied repair file alongside the
  // new one; only the new one is unapplied and so only it comes back in
  // applied.
  const applyUnrelated = await send(instance, [repair, unrelated]);
  assert.equal(applyUnrelated.status, 200);
  assert.equal(applyUnrelated.body.ok, true);
  assert.deepEqual(applyUnrelated.body.applied, [unrelated.name]);
  assert.deepEqual(applyUnrelated.body.historyNames, [repair.name, unrelated.name]);
});

test("migrate()'s pragma_foreign_key_check error says a violation predates the file it names, when every violation was already there before that file ran", async () => {
  const mf = workerMiniflare(resolve(root, "test/migrate-durable-object.worker.ts"), root, { durableObjects: { PROBE: "MigrateProbe" }, unsafeInspectDurableObjects: true });
  onTestFinished(() => mf.dispose());
  const send = async (instance: string, files: { name: string; sql: string }[]) => {
    const response = await mf.dispatchFetch(`http://localhost/${instance}`, { method: "POST", body: JSON.stringify(files) });
    return { status: response.status, body: await response.json() as {
      ok: boolean; applied: string[]; message: string | null; isMigrationHistoryError: boolean;
      historyNames: string[]; childSchema: string | null; childRows: Record<string, unknown>[];
    } };
  };

  const instance = "predates-probe";
  const handle = await mf.unsafeGetDurableObjectStorage("", "MigrateProbe", { name: instance });
  await handle.exec(`CREATE TABLE parent (id text primary key not null)`);
  await handle.exec(`CREATE TABLE child (id text primary key not null, parent_id text references parent(id))`);
  await handle.exec(`insert into parent values ('p1')`);
  await handle.exec(`pragma foreign_keys=off`);
  await handle.exec(`insert into child values ('c1', 'missing')`);
  await handle.exec(`pragma foreign_keys=on`);

  const unrelated = { name: "0001_unrelated.sql", sql: `create table unrelated (id text primary key not null);` };
  const applyUnrelated = await send(instance, [unrelated]);
  assert.equal(applyUnrelated.status, 200);
  assert.equal(applyUnrelated.body.ok, false);
  assert.equal(applyUnrelated.body.isMigrationHistoryError, false);
  assert.match(applyUnrelated.body.message ?? "", /FOREIGN KEY constraint failed/);
  assert.match(applyUnrelated.body.message ?? "", /predates/);
  // The blocked file's own change still rolled back: it never joined history.
  assert.deepEqual(applyUnrelated.body.historyNames, []);
});
