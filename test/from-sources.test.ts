// A build-level oracle for two FROM-list shapes: a table-valued function
// reading an earlier FROM source's column, and a FROM-clause subquery
// correlated to one. Typer.analyze alone (test/typegen.test.ts,
// test/shapes.test.ts) never appends an "at:" line -- only build() does
// (build.ts's withLocations) -- so the refusal's own acceptance ("refused
// with an at: line") needs a real build, not a direct Typer call.
// Boundary: one throwaway module, not the example; test/build.test.ts (a
// different owner's file) already exercises the example project itself.
import { onTestFinished, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, migration, StatementFailures } from "../src/build/build.ts";
import { fixtureDir, librarySpecifier } from "./fixture-dir.ts";

const root = resolve(import.meta.dirname, "..");

function project(): { dir: string; config: string } {
  const dir = fixtureDir("solarsql-from-sources-");
  mkdirSync(resolve(dir, "shop"));
  symlinkSync(resolve(root, "node_modules"), resolve(dir, "node_modules"), "dir");
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({ type: "module" }));
  const library = resolve(root, "src/index.ts");
  const config = resolve(dir, "config.ts");
  writeFileSync(config, `export default { modules: ["./shop"], migrations: "./migrations", library: ${JSON.stringify(library)} };`);
  return { dir, config };
}

function writeModule(dir: string, imports: string, catalog: string): void {
  writeFileSync(resolve(dir, "shop/module.ts"), [
    `import { table, ${imports} } from ${JSON.stringify(librarySpecifier(resolve(dir, "shop")))};`,
    `import { generated } from "./solarsql.generated.ts";`,
    `export const orders = table(\`create table orders (id text primary key not null, tags text) strict\`);`,
    `export const orderLines = table(\`create table order_lines (id text primary key not null, order_id text not null references orders(id)) strict\`);`,
    catalog,
  ].join("\n"));
}

test("select o.id, j.value from orders o, json_each(o.tags) j builds, and returns one row per array element", async () => {
  const { dir, config } = project();
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeModule(dir, "queries", `export const shopQueries = queries(generated, { tags: "select o.id, j.value as tag from orders o, json_each(o.tags) j" });`);
  await build(config);
  const written = await migration(config, "shop");
  assert.ok(written.filename);

  const { shopQueries } = await import(pathToFileURL(resolve(dir, "shop/module.ts")).href);
  const { node } = await import("../src/node.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(dir, "migrations", written.filename!), "utf8"));
  db.prepare("insert into orders (id, tags) values (?, ?)").run("o1", JSON.stringify(["a", "b"]));
  const rows = await node(db).all(shopQueries.tags);
  assert.deepEqual(rows, [{ id: "o1", tag: "a" }, { id: "o1", tag: "b" }]);
});

test("a FROM-clause subquery reading an earlier FROM item's column is refused, naming the rule, with an at: line", async () => {
  const { dir, config } = project();
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  // A bare SELECT reaches typer.analyze() directly only as a command's own
  // plan item (build.ts's own role="plan"): a queries()/returns entry is
  // role="read", and build.ts checks engine.accesses(sql) on that role
  // before typer.analyze() runs, which would report the engine's raw "no
  // such column" text instead of this file's own refusal. That gap stays
  // open for a command's plan item only; this case covers the plan-item path.
  writeModule(dir, "commands", [
    "export const shopCommands = commands(generated, { paged: { plan: [",
    `  "select o.id, x.id as lid from orders o, (select id from order_lines l where l.order_id = o.id limit 2) x",`,
    "] } });",
  ].join("\n"));
  await assert.rejects(build(config), (e: unknown) => {
    assert.ok(e instanceof StatementFailures, String(e));
    const message = e.message;
    assert.match(message, /FROM-clause subquery/);
    assert.match(message, /does not see another item of the same FROM list/);
    assert.doesNotMatch(message, /no such column/);
    assert.match(message, /\n\s*at: .*shop[\\/]module\.ts/);
    return true;
  });
});
