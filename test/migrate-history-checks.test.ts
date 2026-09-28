// Responsibility: migrate()'s own history bookkeeping (src/durable.ts) --
// the file-list sort, the recorded-history sort, duplicate and
// transaction-control detection, legacy-history adoption, and the
// caller-owns-transaction read -- distinct from the rebuild-safety checks
// test/rebuild-column-loss-migration.test.ts and its siblings already cover.
// Boundary: node (through migrate()) and a hand-built StorageLike for the
// one shape node cannot reach (no inTransaction() at all).
import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, MigrationHistoryError } from "../src/node.ts";
import { REBUILD_HEADER } from "../src/build/scan.ts";

test("a thrown MigrationHistoryError names itself, not the base Error, in its own .name", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    assert.throws(() => migrate(raw, [{ name: "0001.sql", sql: "begin" }]), (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.name, "MigrationHistoryError");
      return true;
    });
  } finally { raw.close(); }
});

test("a solarsql_migrations row inserted out of the file list's own sorted order does not spuriously report a new migration ahead of an applied one", () => {
  const raw = new DatabaseSync(":memory:");
  const sqlA = "select 1";
  const sqlB = "select 2";
  try {
    raw.exec("create table solarsql_migrations (name text primary key not null, applied_at text not null, sql text not null) strict");
    const insert = raw.prepare("insert into solarsql_migrations (name, applied_at, sql) values (?, ?, ?)");
    // Inserted in reverse of name order: solarsql_migrations carries no
    // ORDER BY guarantee (the comment beside migrate()'s own read), so a
    // history read that skipped its own JS-side sort would see this same
    // reversed order and misread "0001_a.sql" as a new file inserted ahead
    // of the already-applied "0002_b.sql".
    insert.run("0002_b.sql", "t", sqlB);
    insert.run("0001_a.sql", "t", sqlA);
    const result = migrate(raw, [{ name: "0001_a.sql", sql: sqlA }, { name: "0002_b.sql", sql: sqlB }]);
    assert.deepEqual(result, []);
  } finally { raw.close(); }
});

test("a duplicate-named file inserted before the one that owns a transaction-control statement still reports the transaction-control refusal, not a duplicate", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    // Both files are named "0001_a.sql": the duplicate check (i - 1) never
    // fires for the first occurrence (there is no earlier item to compare
    // against), so the loop reaches this file's own per-statement
    // transaction-control check before it ever reaches the second
    // occurrence's own duplicate check.
    assert.throws(
      () => migrate(raw, [{ name: "0001_a.sql", sql: "begin" }, { name: "0001_a.sql", sql: "select 1" }]),
      (e: unknown) => {
        assert.ok(e instanceof MigrationHistoryError, String(e));
        assert.equal(e.code, "MIGRATION_TRANSACTION");
        assert.equal(e.message, "The migration runner owns the transaction. Remove transaction control statements.");
        return true;
      },
    );
  } finally { raw.close(); }
});

test("a migration file with only a trailing comment after its last statement does not crash the transaction-control scan", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    const applied = migrate(raw, [{ name: "0001.sql", sql: "create table t (id text primary key not null) strict;\n-- a trailing comment, no statement after it" }]);
    assert.deepEqual(applied, ["0001.sql"]);
  } finally { raw.close(); }
});

test("a statement whose comment-stripped text spells a new line comment does not crash the transaction-control scan, and does not block an earlier file from applying", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    // splitStatements() strips each comment token, then keeps the segment
    // when what remains is non-empty; here that leaves the two dashes of
    // "-/**/-" adjacent, with no space where the block comment used to be.
    // A fresh tokenize() of that surviving text, "--", reads it as one new
    // line comment (not the two unrelated dashes it started as), so this
    // segment's own significant-token list is empty.
    assert.throws(
      () => migrate(raw, [{ name: "0001.sql", sql: "create table t(x);" }, { name: "0002.sql", sql: "select 1;\n-/**/-" }]),
      (e: unknown) => {
        assert.equal(e instanceof TypeError, false, String(e));
        return true;
      },
    );
    assert.deepEqual(raw.prepare("select name from solarsql_migrations").all().map((r) => r.name), ["0001.sql"]);
  } finally { raw.close(); }
});

test("a missing migration names the file and states the repair", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    migrate(raw, [{ name: "0001.sql", sql: "create table t (id text primary key not null) strict" }]);
    assert.throws(() => migrate(raw, []), (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "MISSING_MIGRATION");
      assert.equal(e.message, "Applied migration is missing: 0001.sql. Supply the full history.");
      return true;
    });
  } finally { raw.close(); }
});

test("a new migration inserted ahead of an applied one names the applied file and states the repair", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    migrate(raw, [{ name: "0002.sql", sql: "create table t (id text primary key not null) strict" }]);
    assert.throws(() => migrate(raw, [{ name: "0001.sql", sql: "select 1" }, { name: "0002.sql", sql: "create table t (id text primary key not null) strict" }]), (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "MIGRATION_ORDER");
      assert.equal(e.message, "A new migration precedes applied migration 0002.sql. Append a new file instead.");
      return true;
    });
  } finally { raw.close(); }
});

test("an applied legacy row with no recorded SQL names the file and states the repair, without adoption", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    raw.exec("create table solarsql_migrations (name text primary key not null, applied_at text not null) strict; insert into solarsql_migrations (name, applied_at) values ('0001.sql', 't')");
    assert.throws(() => migrate(raw, [{ name: "0001.sql", sql: "select 1" }]), (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "LEGACY_HISTORY");
      assert.equal(e.message, "Migration 0001.sql has no recorded SQL. Verify the legacy files before using adoptLegacyHistory.");
      return true;
    });
  } finally { raw.close(); }
});

test("a changed applied migration's SQL names the file and states the repair", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    migrate(raw, [{ name: "0001.sql", sql: "create table t (id text primary key not null) strict" }]);
    assert.throws(() => migrate(raw, [{ name: "0001.sql", sql: "create table t (id text primary key not null, a text) strict" }]), (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "MIGRATION_CHANGED");
      assert.equal(e.message, "Applied migration changed: 0001.sql. Restore it and append a new migration.");
      return true;
    });
  } finally { raw.close(); }
});

test("adopting a legacy history with a mix of recorded and unrecorded SQL backfills the missing row from its own file, not another file's", () => {
  const raw = new DatabaseSync(":memory:");
  const sqlPre = "create table pre (id text primary key not null) strict";
  const sqlA = "create table a (id text primary key not null) strict";
  try {
    // A hand-built history: "sql" already exists as a column (unlike the
    // no-column legacy test above), but one row (the legacy one) never
    // recorded it (NULL) while the other already carries its own text. The
    // backfill loop below (src/durable.ts) writes every row here, not only
    // the null one -- each row's own update statement looks its file up by
    // that row's own name, so a lookup that ignored the name and grabbed
    // the wrong file would write "0000_pre.sql"'s own text into the
    // "0001_a.sql" row too; both assertions below catch that, since each
    // file's own text here is distinct.
    raw.exec("create table solarsql_migrations (name text primary key not null, applied_at text not null, sql text) strict");
    raw.prepare("insert into solarsql_migrations (name, applied_at, sql) values ('0000_pre.sql', 't', null), (?, 't', ?)").run("0001_a.sql", sqlA);
    raw.exec(sqlPre);
    raw.exec(sqlA);
    assert.deepEqual(
      migrate(raw, [{ name: "0000_pre.sql", sql: sqlPre }, { name: "0001_a.sql", sql: sqlA }], { adoptLegacyHistory: true }),
      [],
    );
    assert.equal(raw.prepare("select sql from solarsql_migrations where name = '0000_pre.sql'").get()!.sql, sqlPre);
    assert.equal(raw.prepare("select sql from solarsql_migrations where name = '0001_a.sql'").get()!.sql, sqlA);
  } finally { raw.close(); }
});

test("a legacy table with no sql column at all, and no rows, adds the column and runs no update against the history table", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    raw.exec("create table solarsql_migrations (name text primary key not null, applied_at text not null) strict");
    const { migrate: migrateStorage } = await import("../src/durable.ts");
    const { storageOf } = await import("../src/node.ts");
    const base = storageOf(raw);
    const execSql: string[] = [];
    const spied = {
      sql: { exec: (sql: string, ...values: unknown[]) => { execSql.push(sql); return base.sql.exec(sql, ...values); } },
      transactionSync: base.transactionSync,
      inTransaction: () => base.inTransaction!(),
    };
    const applied = migrateStorage(spied, [{ name: "0001.sql", sql: "create table t (id text primary key not null) strict" }]);
    assert.deepEqual(applied, ["0001.sql"]);
    const cols = raw.prepare("select name from pragma_table_xinfo('solarsql_migrations')").all().map((r) => r.name);
    assert.deepEqual(cols, ["name", "applied_at", "sql"]);
    // The history table has no row yet at this point (0001.sql has not been
    // applied), so the backfill loop's own `for (const row of history)`
    // never runs its body: no `update solarsql_migrations` statement here.
    assert.equal(execSql.some((s) => s.startsWith("update solarsql_migrations")), false);
  } finally { raw.close(); }
});

test("a stale rebuild record naming a table that no longer exists at all is skipped by the rebuild-safety checks, not run against it", () => {
  // "gone" is dropped entirely by 0002, unrelated to 0003 below. 0003's own
  // stale RebuildRecord still names "gone" and its old index, from before
  // the drop, and its own (hand-crafted) statements recreate an index of
  // that same name "on gone" -- a shape a real generator would not produce,
  // built here only to exercise the table-is-absent branch: pragma_table_
  // xinfo() on a name that names nothing live returns zero columns, so the
  // rebuild-safety checks skip this record and let 0003's own statements
  // run, which then fail on their own (a plain engine error, not a refusal)
  // because "gone" is not there for them to target either.
  const raw = new DatabaseSync(":memory:");
  const file1 = { name: "0001_base.sql", sql: "create table gone (id integer primary key not null, a integer) strict; create index idx_a on gone(a);" };
  const file2 = { name: "0002_drop_gone.sql", sql: "drop index idx_a; drop table gone;" };
  const header = REBUILD_HEADER + JSON.stringify([{ table: "gone", columns: [], constraints: [], indexes: ["CREATE INDEX idx_a ON gone (a)"], triggers: [] }]);
  const file3 = { name: "0003_stale.sql", sql: `${header}\ncreate index idx_a on gone(a);` };
  try {
    migrate(raw, [file1, file2]);
    assert.throws(() => migrate(raw, [file1, file2, file3]), (e: unknown) => {
      // Not a MigrationHistoryError, and specifically not
      // REBUILD_REVIVES_DECLARATION: the check that would report that code
      // never runs for a table this absent.
      assert.equal(e instanceof MigrationHistoryError, false, String(e));
      assert.match((e as Error).message, /no such table/);
      return true;
    });
  } finally { raw.close(); }
});

test("an already-migrated database makes no row-level write on a later activation, and does not re-attempt to add the sql column", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    migrate(raw, [{ name: "0001.sql", sql: "create table t (id text primary key not null) strict" }]);
    const before = raw.prepare("select total_changes() as n").get()!.n as number;
    // total_changes() does not count an ALTER TABLE (measured directly), so
    // it alone would not catch a second, wrongly re-triggered `alter table
    // ... add column sql text`; that statement fails outright on a column
    // that already exists ("duplicate column name"), so the call below not
    // throwing is what rules that out.
    const applied = migrate(raw, [{ name: "0001.sql", sql: "create table t (id text primary key not null) strict" }]);
    assert.deepEqual(applied, []);
    const after = raw.prepare("select total_changes() as n").get()!.n as number;
    assert.equal(after, before);
  } finally { raw.close(); }
});
