// The engine answers questions about SQL by preparing it. These tests pin
// the answers the type generator and the boundary check rely on.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { Engine } from "../src/build/facts.ts";
import { introspect, diff, applied } from "../src/build/migration.ts";
import { analyzeSchema } from "../src/build/analyze.ts";
import { Typer } from "../src/build/typegen.ts";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

const ddl = [
  `create table customers (id text primary key not null, name text not null)`,
  `create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    parent_id text references orders(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text
  )`,
  `create table order_lines (id text primary key not null, order_id text not null references orders(id), qty integer not null, price real)`,
];

test("legal sqlite-prefixed objects survive analysis and populated migrations", () => {
  for (const name of ["sqliteCache", "SQLiteCache", "sqlite", "sqlite2"]) {
    const ddl = [
      `create table ${name}(id integer primary key autoincrement,value text) strict`,
      `create index sqliteIndex on ${name}(value)`,
      `create view sqliteView as select value from ${name}`,
      `create trigger sqliteTrigger after update on ${name} begin select 1; end`,
      `create virtual table search using fts5(value)`,
    ];
    const engine = new Engine(ddl), target = new Engine(ddl.map(sql => sql.replace("value text)", "value text not null)")));
    try {
      engine.db.exec(`insert into ${name} values(42,'kept')`);
      assert.deepEqual(engine.tables().map(t => t.name).sort(), [name, "search"].sort());
      const schema = introspect(engine.db);
      assert.deepEqual([...schema.tables.keys()], [name]);
      assert.deepEqual([...schema.indexes.keys()], ["sqliteIndex"]);
      assert.deepEqual([...schema.views.keys()], ["sqliteView"]);
      assert.deepEqual([...schema.triggers.keys()], ["sqliteTrigger"]);
      const query = `select value from sqliteView`;
      assert.equal(analyzeSchema(ddl.join(';'), { query }).operations[0]!.columns[0]!.type, "string | null");
      const plan = diff(schema, introspect(target.db));
      if (plan.kind !== "ok") throw new Error(plan.reason);
      engine.db.exec("begin");
      for (const sql of plan.statements) engine.db.exec(sql);
      engine.db.exec("commit");
      assert.deepEqual({ ...engine.db.prepare(`select * from ${name}`).get() }, { id:42, value:"kept" });
      assert.deepEqual(diff(introspect(engine.db),introspect(target.db)), {kind:"ok",statements:[]});
    } finally { engine.close(); target.close(); }
  }
});

test("table attributes retain their engine meaning through arbitrary comments", () => {
  hegel.test(tc => {
    const strict = tc.draw(gs.booleans());
    const withoutRowid = tc.draw(gs.booleans());
    const comment = tc.draw(gs.text({ maxSize: 50 })).replaceAll("\0", "").replaceAll("*/", "* /");
    const options = [strict ? "strict" : "", withoutRowid ? "without rowid" : ""].filter(Boolean).join(", ");
    const engine = new Engine([`create table t(id text primary key, value text) /* ${comment} strict without rowid */ ${options}`]);
    try {
      for (const facts of [engine.table("t"), introspect(engine.db).tables.get("t")!]) {
        assert.equal(facts.strict, strict);
        assert.equal(facts.withoutRowid, withoutRowid);
      }
      if (!strict) {
        engine.db.exec("insert into t values ('id', x'00')");
        assert.equal(engine.db.prepare("select typeof(value) as storage from t").get()!.storage, "blob");
        assert.equal(new Typer(engine, new Map(), { conservativeStorage: true }).analyze("select value from t", "t").columns[0]!.type, "SqlValue | null");
      }
    } finally { engine.close(); }
  });
});

test("virtual table facts use the parsed table kind through comments", () => {
  const engine = new Engine(["create /* spacing */ virtual table search using fts5(value)"]);
  try {
    assert.equal(engine.table("search").virtual, true);
    assert.ok(engine.table("search").columns.some(c => c.name === "rank" && c.hidden));
    assert.deepEqual([...introspect(engine.db).virtuals.keys()], ["search"]);
    assert.equal(introspect(engine.db).tables.size, 0);
  } finally { engine.close(); }
});

// SQLite resolves a CHECK expression once, at this CREATE, and never
// reconsiders it on a later INSERT or UPDATE -- so a denied function inside
// one is caught here or nowhere (ADR 0114). The constructor itself, not
// Engine.prepare(), is what must refuse it.
test("a CHECK constraint calling a function D1 and Durable Object storage would refuse is refused at CREATE", () => {
  assert.throws(
    () => new Engine([`create table t (id text primary key not null, a text, check (a != sqlite_version())) strict`]),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /not authorized to use function: sqlite_version/);
      assert.match(e.message, /in: create table t/);
      return true;
    },
  );
});

describe("Engine", () => {
  const engine = new Engine(ddl);

  test("table facts: pk, notnull, oneOf, foreign keys", () => {
    const orders = engine.table("orders");
    assert.deepEqual(orders.columns.map((c) => [c.name, c.type, c.notnull, c.pk, c.oneOf]), [
      ["id", "TEXT", true, 1, null],
      ["customer_id", "TEXT", true, 0, null],
      ["parent_id", "TEXT", false, 0, null],
      ["status", "TEXT", true, 0, ["draft", "confirmed"]],
      ["note", "TEXT", false, 0, null],
    ]);
    assert.deepEqual(orders.foreignKeys, [
      { table: "orders", from: "parent_id", to: "id" },
      { table: "customers", from: "customer_id", to: "id" },
    ]);
    assert.equal(orders.withoutRowid, false);
    assert.equal(orders.strict, false);
    const strict = new Engine(["create table s (id text primary key) strict"]).table("s");
    assert.equal(strict.strict, true);
    // A STRICT table makes its primary key NOT NULL without the words.
    assert.equal(strict.columns[0]!.notnull, true);
  });

  // Read by the join fan-out proof (typegen.ts, ADR 0136): a UNIQUE
  // constraint or CREATE UNIQUE INDEX (not a PRIMARY KEY, already on
  // ColumnFact.pk), not partial, every key column a plain reference (not
  // an expression), with each key column's own collation.
  test("uniqueIndexes: a unique index, a partial one, an expression one, and a column's own declared collation", () => {
    const engine = new Engine([
      `create table t (
        id text primary key not null,
        code text not null,
        partial_code text,
        nocase_code text collate nocase not null
      )`,
      `create unique index t_code on t(code)`,
      `create unique index t_partial on t(partial_code) where partial_code is not null`,
      `create unique index t_expr on t(lower(code))`,
      `create unique index t_nocase on t(nocase_code collate binary)`,
    ]);
    const t = engine.table("t");
    assert.deepEqual(new Set(t.uniqueIndexes.map((u) => JSON.stringify(u))), new Set([JSON.stringify({ columns: [{ name: "code", collation: "BINARY" }] }), JSON.stringify({ columns: [{ name: "nocase_code", collation: "BINARY" }] })]));
    assert.deepEqual(t.columns.map((c) => [c.name, c.collation]), [["id", "BINARY"], ["code", "BINARY"], ["partial_code", "BINARY"], ["nocase_code", "NOCASE"]]);
  });

  test("columns: origins through aliases and views, null for expressions", () => {
    const cols = engine.columns("select o.id as order_id, c.name, count(*) as n from orders o join customers c on c.id = o.customer_id group by o.id");
    assert.deepEqual(cols, [
      { name: "order_id", table: "orders", column: "id", type: "TEXT" },
      { name: "name", table: "customers", column: "name", type: "TEXT" },
      { name: "n", table: null, column: null, type: null },
    ]);
  });

  test("affinities: only a column reference or a CAST has a type", () => {
    const a = engine.affinities("select o.id, count(*) as n, cast(count(*) as integer) as m, cast(sum(l.price) as real) as total, o.status || '!' as s from orders o left join order_lines l on l.order_id = o.id group by o.id");
    assert.deepEqual([...a], [["id", "TEXT"], ["n", ""], ["m", "INT"], ["total", "REAL"], ["s", ""]]);
  });

  test("accesses: every column read, the tables written, the foreign key parent read", () => {
    const reads = engine.accesses("insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')");
    assert.deepEqual(reads.filter((a) => a.action !== "function").map((a) => `${a.action} ${a.table}.${a.column}`).sort(), [
      "insert orders.null",
      "read customers.id",
      "read orders.id",
    ]);
    const select = engine.accesses("select o.id, c.name from orders o join customers c on c.id = o.customer_id");
    assert.deepEqual(select.filter((a) => a.action === "read").map((a) => `${a.table}.${a.column}`).sort(), ["customers.id", "customers.name", "orders.customer_id", "orders.id"]);
  });

  test("fullScans: a scan through an index counts, a search and json_each do not", () => {
    const e = new Engine([`create table t (id text primary key not null, a text not null, b text) strict`, `create index t_a on t (a)`]);
    const plan = (sql: string) => e.fullScans(sql);
    assert.deepEqual(plan("select id from t where b = :b"), ["t"]);
    assert.deepEqual(plan("select id from t where b = :b order by id"), ["t"]);
    assert.deepEqual(plan("select id from t where length(id) > 0 order by id"), ["t"]);
    assert.deepEqual(plan("select id from t where a = :a"), []);
    assert.deepEqual(plan("select id from t where id in (select value from json_each(:ids))"), []);
  });

  test("fullScans does not report a derived-table alias as a scanned table", () => {
    const e = new Engine([`create table orders (id text primary key not null, status text not null) strict`]);
    const scans = e.fullScans("select id from (select * from orders limit 5) sub where sub.status='x'");
    assert.deepEqual(scans, ["orders"]);
  });

  test("fullScans does not report a CTE name as a scanned table", () => {
    const e = new Engine([`create table orders (id text primary key not null, status text not null) strict`]);
    const scans = e.fullScans("with c as (select * from orders limit 5) select id from c where status='x'");
    assert.deepEqual(scans, ["orders"]);
  });

  test("fullScans reports a LEFT JOIN's null-producing side, whose SCAN line SQLite marks with a trailing LEFT-JOIN word", () => {
    const e = new Engine([
      `create table orders (id text primary key not null, customer_id text not null)`,
      `create table order_lines (id text primary key not null, order_id text not null, sku text not null)`,
    ]);
    const scans = e.fullScans("select o.id, l.sku from orders o left join order_lines l on l.order_id = o.id where o.id = :id");
    assert.ok(scans.includes("order_lines"));
  });

  test("fullScans reports an EXISTS correlated subquery's scan, whose SCAN line SQLite marks with a trailing EXISTS word", () => {
    const e = new Engine([
      `create table orders (id text primary key not null, customer_id text not null)`,
      `create table shipments (id text primary key not null, order_id text not null, carrier text not null)`,
    ]);
    const scans = e.fullScans("select o.id from orders o where o.id = :id and exists (select 1 from shipments s where s.order_id = o.id)");
    assert.ok(scans.includes("shipments"));
  });

  test("fullScans reports a LEFT JOIN scan that walks an index in ORDER BY order, whose SCAN line carries the trailing LEFT-JOIN word after the USING INDEX clause", () => {
    const e = new Engine([
      `create table orders (id text primary key not null, customer_id text not null)`,
      `create table order_lines (id text primary key not null, order_id text not null, sku text not null)`,
      `create index idx_sku on order_lines (sku)`,
    ]);
    const scans = e.fullScans("select o.id, l.sku from orders o left join order_lines l on l.order_id = o.id where o.id = :id order by l.sku");
    assert.ok(scans.includes("order_lines"));
  });

  test("fullScans still reports a RIGHT JOIN's scanned side (its SCAN line carries no trailing qualifier)", () => {
    const e = new Engine([
      `create table orders (id text primary key not null, customer_id text not null)`,
      `create table order_lines (id text primary key not null, order_id text not null, sku text not null)`,
    ]);
    const scans = e.fullScans("select o.id, l.sku from order_lines l right join orders o on l.order_id = o.id where o.id = :id");
    assert.deepEqual(scans, ["order_lines"]);
  });

  test("fullScans still excludes a constant-row scan (\"SCAN 2 CONSTANT ROWS\"), whose candidate is not a real alias", () => {
    const scans = engine.fullScans("with c(x) as (values (1),(2)) select x from c where x > 0");
    assert.deepEqual(scans, []);
  });

  test("fullScans reports both tables when an outer join and an unrelated subquery reuse the same alias", () => {
    const e = new Engine([
      `create table orders (id text primary key not null, customer_id text not null)`,
      `create table order_lines (id text primary key not null, order_id text not null, sku text not null)`,
      `create table shipments (id text primary key not null, order_id text not null, carrier text not null)`,
    ]);
    // The LEFT JOIN's own "l" (order_lines) and the EXISTS subquery's own
    // "l" (shipments) are unrelated declarations that happen to reuse the
    // same alias text. Both are genuine full scans (neither table has a
    // non-pk index), and both must be reported even though a last-wins
    // alias map can resolve only one of the two SCAN plan lines correctly.
    const scans = e.fullScans("select o.id from orders o left join order_lines l on l.order_id = o.id where o.id = :id and exists (select 1 from shipments l where l.order_id = o.id)");
    assert.deepEqual([...scans].sort(), ["order_lines", "shipments"]);
    // Distinct aliases for the same statement shape must still resolve
    // each SCAN line to its own table, unaffected by the reuse handling.
    const distinct = e.fullScans("select o.id from orders o left join order_lines l on l.order_id = o.id where o.id = :id and exists (select 1 from shipments s where s.order_id = o.id)");
    assert.deepEqual([...distinct].sort(), ["order_lines", "shipments"]);
  });

  test("fullScans does not report a reused alias's indexed table when a different plan line resolves it by name", () => {
    const e = new Engine([
      `create table orders (id text primary key not null, customer_id text not null)`,
      `create table order_lines (id text primary key not null, order_id text not null, sku text not null)`,
      `create table shipments (id text primary key not null, order_id text not null, carrier text not null)`,
    ]);
    // The EXISTS subquery's own "l" searches shipments by its primary key
    // (a real index, not a full scan): that SEARCH line names the index, so
    // it resolves "l" to shipments there. Only the LEFT JOIN's own "l"
    // (order_lines) is left unresolved, and only its SCAN line is a genuine
    // full scan. Reporting shipments too would flag an already-indexed
    // table as needing an index.
    const scans = e.fullScans("select o.id from orders o left join order_lines l on l.order_id = o.id where o.id = :id and exists (select 1 from shipments l where l.id = :sid)");
    assert.deepEqual(scans, ["order_lines"]);
  });

  test("fullScans resolves a three-way alias reuse down to the one unindexed table", () => {
    const e = new Engine([
      `create table orders (id text primary key not null, customer_id text not null)`,
      `create table order_lines (id text primary key not null, order_id text not null, sku text not null)`,
      `create table shipments (id text primary key not null, order_id text not null, carrier text not null)`,
      `create table payments (id text primary key not null, amount integer not null)`,
    ]);
    // All three EXISTS subqueries reuse the alias "x". Two search their
    // table by primary key (shipments, order_lines), naming the index that
    // resolves each. The third scans payments by its amount column, which
    // has no index, so it is the only genuine full scan.
    const scans = e.fullScans(
      "select o.id from orders o where o.id = :id " +
      "and exists (select 1 from shipments x where x.id = :sid) " +
      "and exists (select 1 from order_lines x where x.id = :lid) " +
      "and exists (select 1 from payments x where x.amount = 5)",
    );
    assert.deepEqual(scans, ["payments"]);
  });

  test("fullScans still reports a table whose own alias reuse resolves entirely to itself", () => {
    const e = new Engine([`create table orders (id text primary key not null, customer_id text not null)`]);
    // Both declarations of "o" name orders, the only candidate. The outer
    // query searches it by primary key (an indexed line); the EXISTS
    // subquery scans it by customer_id (no index, a genuine full scan).
    // Subtracting the indexed line's table from the candidate set would
    // leave nothing to report for the real SCAN line, so the fix must fall
    // back to the full (single-table) candidate set instead of reporting
    // no table at all.
    const scans = e.fullScans("select o.id from orders o where o.id = :id and exists (select 1 from orders o where o.customer_id = :c)");
    assert.deepEqual(scans, ["orders"]);
  });

  test("fullScans resolves a reused alias's INTEGER PRIMARY KEY point lookup to its one rowid-alias table", () => {
    const e = new Engine([
      `create table ipk (id integer primary key not null, tag text not null)`,
      `create table shipments (id text primary key not null, order_id text not null, carrier text not null)`,
    ]);
    // "x" names ipk's own point lookup (SEARCH ... USING INTEGER PRIMARY
    // KEY (rowid=?), no named index) and shipments' own unindexed scan on
    // carrier. ipk is a true rowid alias, the only candidate with that
    // access-path shape, so the point-lookup line resolves it and only the
    // genuine scan on shipments is reported.
    const scans = e.fullScans(
      "select s.id from shipments s where s.order_id = :oid " +
      "and exists (select 1 from ipk x where x.id = :xid) " +
      "and exists (select 1 from shipments x where x.carrier = :c)",
    );
    assert.deepEqual(scans, ["shipments"]);
  });

  test("fullScans resolves a reused alias's WITHOUT ROWID primary-key search to its one table", () => {
    const e = new Engine([
      `create table wr (id text primary key not null, tag text not null) without rowid`,
      `create table shipments (id text primary key not null, order_id text not null, carrier text not null)`,
    ]);
    // Same shape as above, but wr's point lookup is SEARCH ... USING
    // PRIMARY KEY (id=?): WITHOUT ROWID has no rowid, so SQLite names no
    // index for its own primary key either.
    const scans = e.fullScans(
      "select s.id from shipments s where s.order_id = :oid " +
      "and exists (select 1 from wr x where x.id = :xid) " +
      "and exists (select 1 from shipments x where x.carrier = :c)",
    );
    assert.deepEqual(scans, ["shipments"]);
  });

  test("fullScans does not treat an INTEGER PRIMARY KEY DESC table as a rowid alias", () => {
    // DESC gives the column its own named sqlite_autoindex (origin 'pk'),
    // so it is not a rowid alias: pk=1 and type=INTEGER alone would say
    // otherwise, which is why the resolution reuses migration.ts's fuller
    // rowidAlias condition instead of that shortcut. d's own search here is
    // a genuine scan (on tag, not its primary key), while ipk's is a point
    // lookup with no scan at all. A pk+type-only check would count d as a
    // second rowid-alias candidate for ipk's line, leave it unresolved, and
    // report both; the fuller condition excludes d, resolves ipk's line on
    // its own, and reports only d's genuine scan.
    const e = new Engine([
      `create table ipk (id integer primary key not null, tag text not null)`,
      `create table d (id integer primary key desc, tag text not null)`,
      `create table orders (id text primary key not null, customer_id text not null)`,
    ]);
    const scans = e.fullScans(
      "select o.id from orders o where o.id = :id " +
      "and exists (select 1 from ipk x where x.id = :i) " +
      "and exists (select 1 from d x where x.tag = :t)",
    );
    assert.deepEqual(scans, ["d"]);
  });

  test("fullScans still over-reports two rowid-alias candidates that share one alias and one shape (known limitation, left unresolved)", () => {
    const e = new Engine([
      `create table ipk1 (id integer primary key not null, tag text not null)`,
      `create table ipk2 (id integer primary key not null, tag text not null)`,
      `create table shipments (id text primary key not null, order_id text not null, carrier text not null)`,
    ]);
    // ipk1 and ipk2 are both true rowid aliases, so both match the shape
    // filter for either point-lookup line: two matches, not one, leaves
    // the resolution ambiguous by design. The genuine scan on shipments
    // (also reusing "x") is still correctly reported -- the point of this
    // test -- alongside the two false positives that ambiguity leaves in.
    const scans = e.fullScans(
      "select s.id from shipments s where s.order_id = :oid " +
      "and exists (select 1 from ipk1 x where x.id = :i1) " +
      "and exists (select 1 from ipk2 x where x.id = :i2) " +
      "and exists (select 1 from shipments x where x.carrier = :c)",
    );
    assert.ok(scans.includes("shipments"), "the genuine scan must not be dropped");
    assert.deepEqual([...scans].sort(), ["ipk1", "ipk2", "shipments"]);
  });

  test("prepare rejects an unknown column with the engine's message", () => {
    assert.throws(() => engine.prepare("select nope from orders"), /no such column: nope/);
  });
});

// workerd sets these limits on every SQLite connection it opens for D1 and
// a Durable Object (see WORKERD_LIMITS in facts.ts); node:sqlite has none
// of them by default, so a statement that passes engine.prepare() or the
// Engine constructor's DDL loop must also fail (or pass) the same way
// workerd's own connection would. Each pair below pins one limit's boundary
// on both sides -- measurements this round of work took directly.
describe("workerd's prepare-time limits", () => {
  const engine = new Engine(ddl);

  test("a 6-term UNION ALL is refused, a 5-term one is not (compoundSelect 5)", () => {
    const union = (n: number) => Array.from({ length: n }, (_, i) => `select ${i}`).join(" union all ");
    assert.throws(() => engine.prepare(`select * from (${union(6)})`), /too many terms in compound select/i);
    assert.doesNotThrow(() => engine.prepare(`select * from (${union(5)})`));
  });

  test("a 6-term UNION ALL inside a CTE is refused the same way", () => {
    const union = (n: number) => Array.from({ length: n }, (_, i) => `select ${i} as n`).join(" union all ");
    assert.throws(() => engine.prepare(`with u as (${union(6)}) select * from u`), /too many terms in compound select/i);
  });

  test("a 600-row VALUES builds: multi-row VALUES is exempt from compoundSelect", () => {
    const rows = Array.from({ length: 600 }, (_, i) => `(${i})`).join(",");
    assert.doesNotThrow(() => engine.prepare(`select * from (values ${rows})`));
  });

  test("coalesce with 128 arguments is refused, 127 is not (functionArg 127)", () => {
    const args = (n: number) => Array.from({ length: n }, () => "null").join(",");
    assert.throws(() => engine.prepare(`select coalesce(${args(128)})`), /too many arguments on function coalesce/);
    assert.doesNotThrow(() => engine.prepare(`select coalesce(${args(127)})`));
  });

  test("a 101-term addition chain is refused, 100 is not (exprDepth 100)", () => {
    const chain = (n: number) => "1" + "+1".repeat(n - 1);
    assert.throws(() => engine.prepare(`select ${chain(101)}`), /expression tree is too large/i);
    assert.doesNotThrow(() => engine.prepare(`select ${chain(100)}`));
  });

  test("101 result columns are refused, 100 are not (column 100)", () => {
    const cols = (n: number) => Array.from({ length: n }, (_, i) => `1 as c${i}`).join(",");
    assert.throws(() => engine.prepare(`select ${cols(101)}`), /too many columns in result set/);
    assert.doesNotThrow(() => engine.prepare(`select ${cols(100)}`));
  });

  test("101 columns in a CREATE TABLE are refused, 100 are not, at the Engine constructor's own DDL loop (column 100)", () => {
    const cols = (n: number) => Array.from({ length: n }, (_, i) => `c${i} integer`).join(",");
    assert.throws(() => new Engine([`create table wide (${cols(101)})`]), /too many columns on wide/);
    const built = new Engine([`create table wide (${cols(100)})`]);
    built.close();
  });

  test("101 named parameters are refused, 100 are not (variableNumber 100)", () => {
    const params = (n: number) => Array.from({ length: n }, (_, i) => `:p${i}`).join(",");
    assert.throws(() => engine.prepare(`select ${params(101)}`), /too many sql variables/i);
    assert.doesNotThrow(() => engine.prepare(`select ${params(100)}`));
  });

  test("a 100,001-byte statement is refused, a 99,990-byte one is not (sqlLength 100,000)", () => {
    // The 99,990-byte case is the regression test for call-scoped limits: a
    // connection-wide limit was measured and rejected because it also
    // catches the Engine's own internal wrapper SQL (fullScans' `explain
    // query plan`, columns()' temp-table dedup) built past 100 KB or 100
    // columns, turning those into false build errors. A call-scoped limit
    // leaves the wrapper calls, which run outside this one prepare(), at
    // the connection's real (unlimited) size.
    const padded = (bytes: number) => {
      const prefix = "select 1 as a --";
      return prefix + " " + "x".repeat(Math.max(0, bytes - prefix.length - 1));
    };
    const over = padded(100_001);
    const under = padded(99_990);
    assert.equal(over.length, 100_001);
    assert.equal(under.length, 99_990);
    assert.throws(() => engine.prepare(over), /string or blob too big/);
    assert.doesNotThrow(() => engine.prepare(under));
  });

  test("about 30,000 EXPLAIN rows is refused with the VDBE-limit message, about 10,000 builds (vdbeOp 25,000)", () => {
    // Single-column VALUES keeps the SQL text compact: 14,995 rows is
    // ~30,000 EXPLAIN rows at 60,002 bytes of SQL text, well under the
    // 100,000-byte sqlLength boundary above, so the sqlLength check never
    // fires first. Both fixtures sit outside the 15,000-25,000 op band
    // where node:sqlite and a Durable Object were measured to disagree
    // (test/miniflare/prepare-limits.test.ts asserts that band is empty).
    const values = (rows: number) => `select * from (values ${Array.from({ length: rows }, (_, i) => `(${i})`).join(",")})`;
    const refused = values(14_995);
    const built = values(4_995);
    assert.throws(() => engine.prepare(refused), /workerd's compiled-instruction limit \(25000\)/);
    assert.doesNotThrow(() => engine.prepare(built));
  });

  test("a migration file exceeding a limit is refused by applied(), the second DDL replay path outside Engine (ADR 0134)", () => {
    const cols = (n: number) => Array.from({ length: n }, (_, i) => `c${i} integer`).join(",");
    assert.throws(
      () => applied([`create table wide (${cols(101)});`], ["0001_wide.sql"]),
      /migration 0001_wide\.sql, statement 1 of 1: too many columns on wide/,
    );
    const db = applied([`create table wide (${cols(100)});`], ["0001_wide.sql"]);
    db.close();
  });

  test("a caller-supplied connection's limits are unchanged after a build, on both a passing and a failing prepare", () => {
    const db = engine.db;
    const before = { ...db.limits };
    engine.prepare("select 1");
    assert.deepEqual({ ...db.limits }, before);
    assert.throws(() => engine.prepare("select coalesce(" + Array.from({ length: 128 }, () => "null").join(",") + ")"));
    assert.deepEqual({ ...db.limits }, before);
  });
});

test('legal generated sqlite-prefixed names remain visible to both metadata readers', () => {
  hegel.test(tc => {
    const suffix = tc.draw(gs.arrays(gs.integers({minValue:65,maxValue:90}), {maxSize:20})).map(n => String.fromCharCode(n)).join('');
    const name = 'sqlite' + suffix;
    const engine = new Engine([`create table "${name}"(value text) strict`]);
    try {
      engine.db.prepare(`select value from "${name}"`);
      assert.equal(engine.tables()[0]?.name,name);
      assert.equal(introspect(engine.db).tables.has(name),true);
    } finally {engine.close();}
  });
});
