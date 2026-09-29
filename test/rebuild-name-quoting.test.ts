// Responsibility: renamedCreate()'s regex isolates a CREATE TABLE
// declaration's own name -- double-quoted, single-quoted, backtick-quoted,
// and bracket-quoted, plus the plain unquoted case -- so a rebuild's own
// temporary copy table always gets the substituted name. A malformed
// substitution corrupts the CREATE statement text, which fails to execute
// (or silently keeps the wrong name), so each case here forces a real
// rebuild and replays it against a live database. It does not cover an
// IF NOT EXISTS clause or irregular whitespace around CREATE TABLE:
// sqlite_schema always stores that part of a table's own declaration
// canonicalized (single spaces, upper case, IF NOT EXISTS dropped), so
// renamedCreate() -- whose only caller passes that stored text -- never
// actually sees either one (see its own comment in migration.ts). A
// single-quoted name that holds whitespace or "(" used to leave the
// trailing quote in the CREATE body; those cases are covered below.
import { test } from "vitest";
import assert from "node:assert/strict";
import { diff, introspect, open } from "../src/build/migration.ts";

// Toggling STRICT always forces a rebuild, whatever the table's own name or
// column set, so it isolates renamedCreate()'s own name handling from the
// unrelated column-change checks a NOT NULL tightening would also exercise.
function assertRebuildRenames(ddl: string): void {
  const current = open([ddl]);
  const target = open([`${ddl} strict`]);
  try {
    // Seed one row under the table's own name so a broken CREATE is not the
    // only failure mode: a rebuild that drops or mis-names the copy must
    // also fail the preserved-row check below.
    const name = current.prepare("select name from sqlite_schema where type = 'table'").get()!.name as string;
    current.prepare(`insert into ${quoteTable(name)} values (1, 'keep')`).run();
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind !== "ok") return;
    assert.ok(plan.statements.some((s) => s.includes("_solarsql_new_")), JSON.stringify(plan.statements));
    for (const sql of plan.statements) current.exec(sql);
    assert.deepEqual(diff(introspect(current), introspect(target)), { kind: "ok", statements: [] });
    assert.deepEqual(current.prepare(`select id, value from ${quoteTable(name)}`).all().map((r) => ({ ...r })), [{ id: 1, value: "keep" }]);
  } finally {
    current.close();
    target.close();
  }
}

// Match quoteIdent for the seeded DML: every name shape this file rebuilds
// is safe under double quotes (SQLite's identifier form for arbitrary bytes).
function quoteTable(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

test("a rebuild renames a backtick-quoted table name with an embedded space", () => {
  assertRebuildRenames("create table `my table` (id integer primary key not null, value text)");
});

test("a rebuild renames a bracket-quoted table name with an embedded space", () => {
  assertRebuildRenames("create table [my table] (id integer primary key not null, value text)");
});

test("a rebuild renames a double-quoted table name holding an escaped internal quote", () => {
  assertRebuildRenames(`create table "a""b" (id integer primary key not null, value text)`);
});

// A quoted name holding a space rules out the regex's own bare-word
// fallback ([^\s(]+, which stops at the first space) silently matching a
// truncated name instead of the intended quoted-name alternative.
test("a rebuild renames a double-quoted table name holding an embedded space", () => {
  assertRebuildRenames(`create table "my table" (id integer primary key not null, value text)`);
});

test("a rebuild renames a plain, unquoted table name immediately followed by its column list", () => {
  assertRebuildRenames("create table t(id integer primary key not null, value text)");
});

test("a rebuild renames a single-quoted table name with an embedded space", () => {
  assertRebuildRenames("create table 'my table' (id integer primary key not null, value text)");
});

// "(" would also truncate the bare-word fallback, and an unmatched trailing
// quote would stay in the CREATE body as a syntax error at execution.
test("a rebuild renames a single-quoted table name holding an opening parenthesis", () => {
  assertRebuildRenames("create table 'my(table' (id integer primary key not null, value text)");
});

test("a rebuild renames a single-quoted table name holding an escaped internal quote", () => {
  assertRebuildRenames("create table 'a''b' (id integer primary key not null, value text)");
});
