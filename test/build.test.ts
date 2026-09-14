// `solarsql build` on the example: the committed generated files are
// current, the migration files are current, and the build refuses the
// shapes the design rules out. Each case works on a copy of the example.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, migration } from "../src/build/build.ts";
import { BuildError } from "../src/build/typegen.ts";
import { nextMigrationFile, withMigrationLock, writeNewMigration } from "../src/build/migration-files.ts";

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
      assert.ok(result.modules.every((m) => Number.isInteger(m.ms) && m.ms >= 0));
      assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
      assert.deepEqual(result.migration, { pending: false, statements: [], reason: null });
      // orderQueries.byNote filters with LIKE on a column without an index, and the build says so.
      assert.deepEqual(result.scans.map((s) => [s.module, s.tables, /note like/.test(s.sql)]), [["orders", ["orders"], true]]);
      assert.deepEqual(result.reads, [
        { module: "reports", query: "revenueByCustomer", tables: ["customers", "order_lines", "orders"] },
        { module: "reports", query: "confirmedOrders", tables: ["customers", "orders"] },
      ]);
      assert.equal(result.reads.some((r) => r.module === "customers" || r.module === "orders"), false);
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

  test("a fresh clone builds when a module imports a module listed after it", async () => {
    const dir = copy();
    try {
      for (const m of ["customers", "orders", "reports"]) rmSync(join(dir, `example/modules/${m}/solarsql.generated.ts`));
      // A value import, so the module graph reaches orders' generated file at import time.
      const file = join(dir, "example/modules/customers/module.ts");
      writeFileSync(file, `import { orderQueries } from "../orders/public.ts";\nexport const orderQueryNames = Object.keys(orderQueries.entries);\n${readFileSync(file, "utf8")}`);
      const result = await build(join(dir, "example/solarsql.config.ts"));
      assert.deepEqual(result.modules.map((m) => [m.name, m.changed]), [["customers", true], ["orders", true], ["reports", true]]);
      assert.equal(readFileSync(join(dir, "example/modules/orders/solarsql.generated.ts"), "utf8"), readFileSync(join(root, "example/modules/orders/solarsql.generated.ts"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A project that lists its modules in the configuration and exports, from
  // the same file, what the application wires up.
  function configThatImportsOrders(dir: string, modules: string): void {
    writeFileSync(
      join(dir, "example/solarsql.config.ts"),
      [
        'import { config } from "../src/index.ts";',
        'import { orderQueries } from "./modules/orders/public.ts";',
        "export const loaders = { orders: orderQueries };",
        `export default config({ modules: [${modules}], migrations: "./migrations", library: "../../../src/index.ts" });`,
        "",
      ].join("\n"),
    );
  }

  test("a fresh clone builds when the configuration imports a module", async () => {
    const dir = copy();
    try {
      for (const m of ["customers", "orders", "reports"]) rmSync(join(dir, `example/modules/${m}/solarsql.generated.ts`));
      configThatImportsOrders(dir, '"./modules/customers", "./modules/orders", { dir: "./modules/reports", readsAll: true }');
      const result = await build(join(dir, "example/solarsql.config.ts"));
      assert.deepEqual(result.modules.map((m) => m.changed), [true, true, true]);
      for (const m of ["customers", "orders", "reports"]) {
        assert.equal(readFileSync(join(dir, `example/modules/${m}/solarsql.generated.ts`), "utf8"), readFileSync(join(root, `example/modules/${m}/solarsql.generated.ts`), "utf8"));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Its own copy: Node keeps a module it imported once, so a check right
  // after a build in the same process would not reach the import that fails.
  test("a check on a configuration that imports a module reports the missing generated file in the build's words", async () => {
    const dir = copy();
    try {
      for (const m of ["customers", "orders", "reports"]) rmSync(join(dir, `example/modules/${m}/solarsql.generated.ts`));
      configThatImportsOrders(dir, '"./modules/customers", "./modules/orders", { dir: "./modules/reports", readsAll: true }');
      await assert.rejects(build(join(dir, "example/solarsql.config.ts"), { write: false }), (e: unknown) => {
        assert.ok(e instanceof BuildError, String(e));
        assert.match(e.message, /module orders: .*solarsql\.generated\.ts is missing\. Run: npx solarsql build/);
        return true;
      });
      assert.equal(existsSync(join(dir, "example/modules/orders/solarsql.generated.ts")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a configuration that imports a module it does not list is refused, and the stub does not stay", async () => {
    const dir = copy();
    try {
      for (const m of ["customers", "orders", "reports"]) rmSync(join(dir, `example/modules/${m}/solarsql.generated.ts`));
      configThatImportsOrders(dir, '"./modules/customers"');
      await expectBuildError(dir, /module orders: solarsql\.config\.ts imports it, and it is not in modules\. Add "\.\/modules\/orders" to modules\./);
      assert.equal(existsSync(join(dir, "example/modules/orders/solarsql.generated.ts")), false);
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

  test("two independently generated migrations sharing a sequence number are refused before merge", async () => {
    const dir = copy();
    try {
      const migrations = join(dir, "example/migrations");
      writeFileSync(join(migrations, "0006_add_a.sql"), "alter table customers add column note_a text;\n");
      writeFileSync(join(migrations, "0006_add_b.sql"), "alter table customers add column note_b text;\n");
      await assert.rejects(build(join(dir, "example/solarsql.config.ts")), (e: unknown) => {
        assert.ok(e instanceof BuildError, String(e));
        assert.match(e.message, /colliding sequence numbers/);
        assert.match(e.message, /0006_add_a\.sql/);
        assert.match(e.message, /0006_add_b\.sql/);
        assert.ok(e.action?.includes("0006_add_a.sql") && e.action.includes("0006_add_b.sql"), e.action ?? "");
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two migrations with different sequence numbers but colliding DDL are refused with the file named", async () => {
    const dir = copy();
    try {
      const migrations = join(dir, "example/migrations");
      writeFileSync(join(migrations, "0006_add_priority_a.sql"), "alter table customers add column priority text;\n");
      writeFileSync(join(migrations, "0007_add_priority_b.sql"), "alter table customers add column priority text;\n");
      await expectBuildError(dir, /migration 0007_add_priority_b\.sql: duplicate column name: priority/);
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
      // The example already holds five files, so the next one is the sixth.
      assert.equal(written.filename, "0006_placed_at.sql");
      const index = readFileSync(join(dir, "example/migrations/index.ts"), "utf8");
      assert.match(index, /0006_placed_at\.sql/);

      const second = await build(join(dir, "example/solarsql.config.ts"));
      assert.equal(second.migration.pending, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migration refuses a command plan that writes another module's table, and writes no file", async () => {
    const dir = copy();
    try {
      // A genuine schema change, so a migration would otherwise be
      // pending and a file would otherwise be written.
      const schema = join(dir, "example/modules/orders/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8")
        .replace("updated_at text\n", "updated_at text,\n    placed_at integer not null default 0\n")
        .replace(`plan: ["update orders set note = :note where id = :id"],`, `plan: ["update customers set name = :note where id = :id"],`));
      const before = readdirSync(join(dir, "example/migrations"));
      await assert.rejects(migration(join(dir, "example/solarsql.config.ts"), "placed_at"), (e: unknown) => {
        assert.ok(e instanceof BuildError, String(e));
        assert.match(e.message, /module orders updates customers\. Module customers owns customers/);
        return true;
      });
      assert.deepEqual(readdirSync(join(dir, "example/migrations")), before);
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

  test("an index on another module's table is refused", async () => {
    const dir = copy();
    try {
      const module = join(dir, "example/modules/customers/module.ts");
      const text = readFileSync(module, "utf8").replace("import { commands, queries, table }", "import { commands, index, queries, table }");
      writeFileSync(module, text.replace("export const customerQueries", "export const ordersNote = index(`create index orders_note on orders (note)`);\nexport const customerQueries"));
      await expectBuildError(dir, /module customers: index orders_note is on orders, which module orders owns/);
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

  test("changes() in a returns clause is refused", async () => {
    const dir = copy();
    try {
      const commands = join(dir, "example/modules/orders/module.ts");
      writeFileSync(commands, readFileSync(commands, "utf8").replace(
        `returns: "select id, note, updated_at from orders where id = :id",`,
        `returns: "select id, note, updated_at, cast(changes() as integer) as n from orders where id = :id",`,
      ));
      await expectBuildError(dir, /command orders\.annotate: the returns clause uses changes\(\)/);
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

  test("a STRICT comment cannot enable the module storage contract", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/customers/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8").replace(") strict\n", ") /* strict */ without rowid\n"));
      await expectBuildError(dir, /table customers is not STRICT/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a foreign key to a table no module declares is refused, even with no write command touching the table", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/customers/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8") + `
export const referrals = table(\`
  create table referrals (
    id text primary key not null,
    customer_id text references nosuchtable(id)
  ) strict
\`);
`);
      await expectBuildError(dir, /table referrals has a foreign key to nosuchtable, which no module declares/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a foreign key to a real table's nonexistent column is refused", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/customers/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8") + `
export const referrals = table(\`
  create table referrals (
    id text primary key not null,
    customer_id text references customers(nope)
  ) strict
\`);
`);
      await expectBuildError(dir, /table referrals has a foreign key to customers\(nope\), which has no such column/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a foreign key with no column list resolves to the target's primary key and builds", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/customers/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8") + `
export const referrals = table(\`
  create table referrals (
    id text primary key not null,
    customer_id text references customers
  ) strict
\`);
`);
      await build(join(dir, "example/solarsql.config.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a foreign key whose target spelling differs only in case still resolves and builds", async () => {
    const dir = copy();
    try {
      const schema = join(dir, "example/modules/customers/module.ts");
      writeFileSync(schema, readFileSync(schema, "utf8") + `
export const referrals = table(\`
  create table referrals (
    id text primary key not null,
    customer_id text references Customers(id)
  ) strict
\`);
`);
      await build(join(dir, "example/solarsql.config.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an expression column without a cast is refused with the fix in the message", async () => {
    const dir = copy();
    try {
      const queries = join(dir, "example/modules/reports/module.ts");
      writeFileSync(queries, readFileSync(queries, "utf8").replace("cast(count(distinct o.id) as integer) as orders", "count(distinct o.id) as orders"));
      await assert.rejects(build(join(dir, "example/solarsql.config.ts")), (error: unknown) => {
        assert.ok(error instanceof BuildError, String(error));
        assert.equal(error.message, `column "orders" is an expression with no type. Wrap it in cast(... as integer), cast(... as real), cast(... as text), or cast(... as blob).
  in: select c.id as customer_id, c.name, cast(sum(l.qty * l.price) as real) as revenue, count(distinct o.id) as orders from customers c join orders o on o.customer_id = c.id and o.status = 'confirmed' join order_lines l on l.order_id = o.id group by c.id order by revenue desc
  at: ${queries}: query reportQueries.revenueByCustomer`);
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('migration generation appends after gaps without replacing history', async t => {
  const dir = copy(); t.after(() => rmSync(dir, {recursive:true,force:true}));
  const migrations = join(dir,'example/migrations');
  const existing = join(migrations,'0006_collision.sql');
  renameSync(join(migrations,'0005_customer_name_not_empty.sql'),existing);
  const before = readFileSync(existing,'utf8');
  const source = join(dir,'example/modules/orders/module.ts');
  writeFileSync(source,readFileSync(source,'utf8').replace('updated_at text\n','updated_at text,\n    extra integer not null default 0\n'));
  const config = join(dir,'example/solarsql.config.ts');
  const result = await migration(config,'collision');
  assert.equal(result.filename,'0007_collision.sql');
  assert.equal(readFileSync(existing,'utf8'),before);
  assert.equal((await build(config)).migration.pending,false);
  assert.equal(existsSync(join(migrations,'.solarsql-generation.lock')),false);
});

test('migration file publication is exclusive and generation locks are released', async t => {
  const dir = mkdtempSync(join(tmpdir(),'solarsql-migration-lock-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file = {filename:'0001_initial.sql',sql:'create table t(n integer) strict;'};
  writeNewMigration(dir,file);
  assert.throws(()=>writeNewMigration(dir,{...file,sql:'drop table t;'}),/already exists/);
  assert.equal(readFileSync(join(dir,file.filename),'utf8'),file.sql);
  await withMigrationLock(dir,()=>assert.rejects(withMigrationLock(dir,()=>{}),/generation is locked/));
  await assert.rejects(withMigrationLock(dir,()=>{throw new Error('fixture failure')}),/fixture failure/);
  await withMigrationLock(dir,()=>{});
  assert.equal(existsSync(join(dir,'.solarsql-generation.lock')),false);
});

test('a migration write killed before its link leaves no file at the final name', async t => {
  const dir = mkdtempSync(join(tmpdir(),'solarsql-migration-killed-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename = '0001_initial.sql';
  const sql = 'create table t(n integer) strict;';
  const fixture = join(root,'test/fixtures/interrupted-migration-write.ts');
  const child = spawn(process.execPath,[fixture,dir,filename,sql],{stdio:['ignore','pipe','pipe']});
  const killed = new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolvePromise,reject) => {
    let ready = '';
    child.stdout!.on('data', chunk => {
      ready += String(chunk);
      if (ready.includes('about to link')) child.kill('SIGKILL');
    });
    child.on('error', reject);
    child.on('exit', (code,signal) => resolvePromise({code,signal}));
    t.after(() => child.kill('SIGKILL'));
  });
  const {signal} = await killed;
  assert.equal(signal,'SIGKILL');
  assert.equal(existsSync(join(dir,filename)),false);
  const stray = readdirSync(dir).find(name => name.startsWith(`.${filename}.`) && name.endsWith('.tmp'));
  assert.ok(stray, 'a temporary artifact from the interrupted write remains');
  writeNewMigration(dir,{filename,sql});
  assert.equal(readFileSync(join(dir,filename),'utf8'),sql);
  assert.throws(()=>writeNewMigration(dir,{filename,sql:'drop table t;'}),/already exists/);
});

test('migration numbering rejects ambiguous history and unsafe lexical rollover', () => {
  assert.throws(() => nextMigrationFile(['custom.sql'], 'next', []), /invalid sequence at custom\.sql/);
  assert.throws(() => nextMigrationFile(['0001_a.sql', '0001_b.sql'], 'next', []), /colliding sequence numbers at 0001_a\.sql, 0001_b\.sql/);
  assert.throws(() => nextMigrationFile(['0001_a.sql', '0001_b.sql', '0001_c.sql'], 'next', []), /colliding sequence numbers at 0001_a\.sql, 0001_b\.sql, 0001_c\.sql/);
  assert.throws(() => nextMigrationFile(['9999_a.sql', '10000_b.sql'], 'next', []), /ambiguous replay order at 9999_a\.sql.*10000_b\.sql/);
  assert.throws(()=>nextMigrationFile(['9999_last.sql'],'next',[]),/replay before/);
  assert.equal(nextMigrationFile(['00001_a.sql','00009_b.sql'],'next',[]).filename,'00010_next.sql');
});

test('a competing CLI generator reports the held lock and preserves history', async t => {
  const dir = copy(); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const migrations = join(dir,'example/migrations');
  const existing = join(migrations,'0005_customer_name_not_empty.sql');
  const before = readFileSync(existing,'utf8');
  const config = join(dir,'example/solarsql.config.ts');
  await withMigrationLock(migrations,()=>{
    const child = spawnSync(process.execPath,[join(root,'src/build/cli.ts'),'migration','competing',config],{encoding:'utf8',timeout:10_000});
    assert.equal(child.status,1,child.stdout+child.stderr);
    assert.match(child.stderr,/generation is locked/);
    assert.equal(readFileSync(existing,'utf8'),before);
  });
  assert.equal((await migration(config,'after_lock')).filename,null);
});

test('new migration names sort after every generated history with gaps', async () => {
  const {test:property} = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const values = [...new Set(tc.draw(gs.arrays(gs.integers({minValue:0,maxValue:9998}),{maxSize:30})))];
    const history = values.map(n=>`${String(n).padStart(4,'0')}_history.sql`);
    const generated = nextMigrationFile(history,'next',[]);
    assert.ok(history.every(name=>name<generated.filename));
    assert.ok(!history.includes(generated.filename));
    assert.equal(Number(generated.filename.split('_')[0]), Math.max(0,...values)+1);
  });
});
