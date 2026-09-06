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

  test("a check writes nothing, reports the stale file, and stops at a missing one", async () => {
    const dir = copy();
    try {
      const commands = join(dir, "example/modules/orders/module.ts");
      writeFileSync(commands, readFileSync(commands, "utf8").replace("update orders set note = :note where id = :id", "update orders set note = :note where id = :id and status = 'draft'"));
      const generated = join(dir, "example/modules/orders/solarsql.generated.ts");
      const before = readFileSync(generated, "utf8");
      const checked = await build(join(dir, "example/solarsql.config.ts"), { write: false });
      assert.deepEqual(checked.modules.map((m) => [m.name, m.changed]), [["customers", false], ["orders", true], ["reports", false]]);
      assert.equal(readFileSync(generated, "utf8"), before);
      const written = await build(join(dir, "example/solarsql.config.ts"));
      assert.equal(written.modules[1]!.changed, true);
      assert.notEqual(readFileSync(generated, "utf8"), before);
      rmSync(generated);
      await assert.rejects(build(join(dir, "example/solarsql.config.ts"), { write: false }), /module orders: .*solarsql\.generated\.ts is missing\. Run: npx solarsql build/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the migrations index follows the .sql files, and a check reports it stale", async () => {
    const dir = copy();
    try {
      const index = join(dir, "example/migrations/index.ts");
      const file = join(dir, "example/migrations/0002_orders_customer_id.sql");
      const before = readFileSync(index, "utf8");
      assert.equal((await build(join(dir, "example/solarsql.config.ts"), { write: false })).index.changed, false);
      // An edit that keeps the schema: a comment line in one migration file.
      writeFileSync(file, `${readFileSync(file, "utf8")}-- applied on the second of the month\n`);
      const checked = await build(join(dir, "example/solarsql.config.ts"), { write: false });
      assert.deepEqual(checked.index, { path: index, changed: true });
      assert.equal(readFileSync(index, "utf8"), before);
      const written = await build(join(dir, "example/solarsql.config.ts"));
      assert.equal(written.index.changed, true);
      assert.match(readFileSync(index, "utf8"), /applied on the second of the month/);
      // Without an index at all, the build writes one.
      rmSync(index);
      await build(join(dir, "example/solarsql.config.ts"));
      assert.match(readFileSync(index, "utf8"), /0004_search\.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed statement is reported as one removed and one added", async () => {
    const dir = copy();
    try {
      const commands = join(dir, "example/modules/orders/module.ts");
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
      const schema = join(dir, "example/modules/orders/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8").replace("updated_at text\n", "updated_at text,\n    placed_at integer not null default 0\n"));
      const first = await build(join(dir, "example/solarsql.config.ts"));
      assert.equal(first.migration.pending, true);
      assert.deepEqual(first.migration.statements, [`alter table "orders" add column placed_at integer not null default 0`]);

      const written = await migration(join(dir, "example/solarsql.config.ts"), "placed_at");
      // The example already holds four files, so the next one is the fifth.
      assert.equal(written.filename, "0005_placed_at.sql");
      const index = readFileSync(join(dir, "example/migrations/index.ts"), "utf8");
      assert.match(index, /0005_placed_at\.sql/);

      const second = await build(join(dir, "example/solarsql.config.ts"));
      assert.equal(second.migration.pending, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a module imports another module through public.ts only", async () => {
    const dir = copy();
    try {
      const queries = join(dir, "example/modules/orders/module.ts");
      const original = readFileSync(queries, "utf8");
      writeFileSync(queries, `import type { CustomersId } from "../customers/public.ts";\n${original}`);
      await build(join(dir, "example/solarsql.config.ts"));
      writeFileSync(queries, `import { customerQueries } from "../customers/module.ts";\n${original}`);
      await expectBuildError(dir, /module orders: module\.ts imports \.\.\/customers\/module\.ts\. Module customers shows public\.ts; import from there/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a delete from a parent table passes, and a read of the child beyond its foreign key does not", async () => {
    // The engine checks a delete from customers by reading orders.customer_id;
    // the example's clear command is that delete, and the build passes it.
    const dir = copy();
    try {
      const queries = join(dir, "example/modules/customers/module.ts");
      writeFileSync(queries, readFileSync(queries, "utf8").replace("all: `", "drafts: `select status from orders`,\n  all: `"));
      await expectBuildError(dir, /module customers reads orders\.status\. Module orders owns orders/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a module that reads another module's table without readsAll is refused", async () => {
    const dir = copy();
    try {
      const queries = join(dir, "example/modules/orders/module.ts");
      writeFileSync(queries, readFileSync(queries, "utf8").replace("byCustomer: `", "names: `select name from customers`,\n  byCustomer: `"));
      await expectBuildError(dir, /module orders reads customers\.name\. Module customers owns customers/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a trigger body that writes another module's table is refused, also under UPDATE OF", async () => {
    for (const head of ["after update on orders", "after update of note on orders", "before delete on orders", "after insert on orders"]) {
      const dir = copy();
      try {
        const schema = join(dir, "example/modules/orders/module.ts");
        const body = readFileSync(schema, "utf8").replace("after update on orders", head).replace("update orders set updated_at", "update customers set name = 'x' where id = new.customer_id;\n    update orders set updated_at");
        // A DELETE trigger sees old, not new; only this trigger's body changes.
        writeFileSync(schema, head.includes("delete") ? body.replace("id = new.customer_id", "id = old.customer_id").replace("where id = new.id", "where id = old.id") : body);
        await expectBuildError(dir, /module orders: trigger orders_touch updates customers\. Module customers owns customers/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("a trigger body the engine refuses is reported with its text", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/orders/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8").replace("after update on orders", "after delete on orders"));
      await expectBuildError(dir, /module orders: trigger orders_touch: no such column: new\.id\n  in: create trigger orders_touch after delete on orders/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("search() needs an FTS5 virtual table, and another module may not read it without readsAll", async () => {
    const dir = copy();
    try {
      const module = join(dir, "example/modules/orders/module.ts");
      const source = readFileSync(module, "utf8");
      writeFileSync(module, source.replace("using fts5(order_id unindexed, note)", "using rtree(id, x0, x1)"));
      await expectBuildError(dir, /module orders: search\(\) needs one CREATE VIRTUAL TABLE \.\.\. USING fts5/);
      writeFileSync(module, source);
      const customers = join(dir, "example/modules/customers/module.ts");
      writeFileSync(customers, readFileSync(customers, "utf8").replace("byId: `", "notes: `select order_id from order_search where order_search match :q`,\n  byId: `"));
      await expectBuildError(dir, /module customers reads order_search\.order_id\. Module orders owns order_search/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a trigger on another module's table is refused", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/orders/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8").replace("after update on orders", "after update on customers"));
      await expectBuildError(dir, /module orders: trigger orders_touch is on customers, which module customers owns/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an INSTEAD OF trigger on a view of the module is checked like a table trigger", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/orders/module.ts");
      const own = `\nexport const notes = view("create view order_notes as select id, note from orders");\nexport const notesInsert = trigger("create trigger order_notes_insert instead of insert on order_notes begin update orders set note = new.note where id = new.id; end");\n`;
      writeFileSync(schema, readFileSync(schema, "utf8").replace(/^import \{ /m, "import { view, ") + own);
      await build(join(dir, "example/solarsql.config.ts"));
      const reports = join(dir, "example/modules/reports/module.ts");
      writeFileSync(reports, readFileSync(reports, "utf8").replace("import { queries, view }", "import { queries, trigger, view }") + `\nexport const drop = trigger("create trigger confirmed_delete instead of delete on confirmed_orders begin delete from orders where id = old.id; end");\n`);
      await expectBuildError(dir, /module reports: trigger confirmed_delete deletes from orders\. Module orders owns orders/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a view that reads another module's table needs readsAll", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/orders/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8").replace(/^import \{ /m, "import { view, ") + `\nexport const names = view("create view customer_names as select id, name from customers");\n`);
      await expectBuildError(dir, /module orders: view customer_names reads customers\.name\. Module customers owns customers/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changes() in an assert that does not follow a statement is refused", async () => {
    const dir = copy();
    try {
      const commands = join(dir, "example/modules/orders/module.ts");
      writeFileSync(commands, readFileSync(commands, "utf8").replace(`assert("has_lines", "exists (select 1 from order_lines where order_id = :id)"),`, `assert("has_lines", "exists (select 1 from order_lines where order_id = :id)"),\n      assert("nothing_changed", "changes() = 0"),`));
      await expectBuildError(dir, /assert nothing_changed uses changes\(\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a table that is not STRICT is refused with the fix in the message", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/customers/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8").replace(") strict\n", ")\n"));
      await expectBuildError(dir, /table customers is not STRICT\. Add `strict`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an expression column without a cast is refused with the fix in the message", async () => {
    const dir = copy();
    try {
      const queries = join(dir, "example/modules/reports/module.ts");
      writeFileSync(queries, readFileSync(queries, "utf8").replace("cast(count(distinct o.id) as integer) as orders", "count(distinct o.id) as orders"));
      await expectBuildError(dir, /column "orders" is an expression with no type/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
