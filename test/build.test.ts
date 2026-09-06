// `solarsql build` on the example: the committed generated files are
// current, the migration files are current, and the build refuses the
// shapes the design rules out. Each case works on a copy of the example.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, migration } from "../src/build/build.ts";
import { BuildError } from "../src/build/typegen.ts";

const root = resolve(import.meta.dirname, "..");

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-build-"));
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(root, "example"), join(dir, "example"), { recursive: true });
  return dir;
}

async function expectBuildError(dir: string, pattern: RegExp): Promise<void> {
  await assert.rejects(build(join(dir, "example/solarsql.config.ts")), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.match(e.message, pattern);
    return true;
  });
}

describe("solarsql build", () => {
  test("the committed example is current: no generated file changes, no migration pending", async () => {
    const dir = copy();
    try {
      const result = await build(join(dir, "example/solarsql.config.ts"));
      assert.deepEqual(result.modules.map((m) => [m.name, m.changed, m.added, m.removed]), [["customers", false, [], []], ["orders", false, [], []], ["reports", false, [], []]]);
      assert.deepEqual(result.migration, { pending: false, statements: [], reason: null });
      // orderQueries.byNote filters with LIKE on a column without an index, and the build says so.
      assert.deepEqual(result.scans.map((s) => [s.module, s.tables, /note like/.test(s.sql)]), [["orders", ["orders"], true]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh clone without generated files builds from stubs", async () => {
    const dir = copy();
    try {
      for (const m of ["customers", "orders", "reports"]) rmSync(join(dir, `example/modules/${m}/solarsql.generated.ts`));
      const result = await build(join(dir, "example/solarsql.config.ts"));
      assert.deepEqual(result.modules.map((m) => m.changed), [true, true, true]);
      // From a stub, every statement is an addition.
      assert.deepEqual(result.modules.map((m) => [m.added.length === m.entries, m.removed]), [[true, []], [true, []], [true, []]]);
      for (const m of ["customers", "orders", "reports"]) {
        assert.equal(readFileSync(join(dir, `example/modules/${m}/solarsql.generated.ts`), "utf8"), readFileSync(join(root, `example/modules/${m}/solarsql.generated.ts`), "utf8"));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed statement is reported as one removed and one added", async () => {
    const dir = copy();
    try {
      const commands = join(dir, "example/modules/orders/commands.ts");
      writeFileSync(commands, readFileSync(commands, "utf8").replace("update orders set note = :note where id = :id", "update orders set note = :note where id = :id and status = 'draft'"));
      const result = await build(join(dir, "example/solarsql.config.ts"));
      const orders = result.modules.find((m) => m.name === "orders")!;
      assert.equal(orders.changed, true);
      assert.deepEqual(orders.removed, ["update orders set note = :note where id = :id"]);
      assert.deepEqual(orders.added, ["update orders set note = :note where id = :id and status = 'draft'"]);
      const again = await build(join(dir, "example/solarsql.config.ts"));
      assert.deepEqual(again.modules.map((m) => [m.changed, m.added, m.removed]), [[false, [], []], [false, [], []], [false, [], []]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a schema change is reported, and `migration` writes the next file", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/orders/schema.ts");
      writeFileSync(schema, readFileSync(schema, "utf8").replace("note text\n", "note text,\n    placed_at integer not null default 0\n"));
      const first = await build(join(dir, "example/solarsql.config.ts"));
      assert.equal(first.migration.pending, true);
      assert.deepEqual(first.migration.statements, [`alter table "orders" add column placed_at integer not null default 0`]);

      const written = await migration(join(dir, "example/solarsql.config.ts"), "placed_at");
      // The example already holds two files, so the next one is the third.
      assert.equal(written.filename, "0003_placed_at.sql");
      const index = readFileSync(join(dir, "example/migrations/index.ts"), "utf8");
      assert.match(index, /0003_placed_at\.sql/);

      const second = await build(join(dir, "example/solarsql.config.ts"));
      assert.equal(second.migration.pending, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a module that reads another module's table without readsAll is refused", async () => {
    const dir = copy();
    try {
      const queries = join(dir, "example/modules/orders/queries.ts");
      writeFileSync(queries, readFileSync(queries, "utf8").replace("byCustomer: `", "names: `select name from customers`,\n  byCustomer: `"));
      await expectBuildError(dir, /module orders reads customers\.name\. Module customers owns customers/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changes() in an assert that does not follow a statement is refused", async () => {
    const dir = copy();
    try {
      const commands = join(dir, "example/modules/orders/commands.ts");
      writeFileSync(commands, readFileSync(commands, "utf8").replace(`assert("has_lines", "exists (select 1 from order_lines where order_id = :id)"),`, `assert("has_lines", "exists (select 1 from order_lines where order_id = :id)"),\n      assert("nothing_changed", "changes() = 0"),`));
      await expectBuildError(dir, /assert nothing_changed uses changes\(\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a table that is not STRICT is refused with the fix in the message", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/customers/schema.ts");
      writeFileSync(schema, readFileSync(schema, "utf8").replace(") strict\n", ")\n"));
      await expectBuildError(dir, /table customers is not STRICT\. Add `strict`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an expression column without a cast is refused with the fix in the message", async () => {
    const dir = copy();
    try {
      const queries = join(dir, "example/modules/reports/queries.ts");
      writeFileSync(queries, readFileSync(queries, "utf8").replace("cast(count(distinct o.id) as integer) as orders", "count(distinct o.id) as orders"));
      await expectBuildError(dir, /column "orders" is an expression with no type/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
