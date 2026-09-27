// Responsibility: renamedCreate()'s regex isolates a CREATE TABLE
// declaration's own name -- double-quoted, backtick-quoted, and
// bracket-quoted, plus the plain unquoted case -- so a rebuild's own
// temporary copy table always gets the substituted name. A malformed
// substitution corrupts the CREATE statement text, which fails to execute
// (or silently keeps the wrong name), so each case here forces a real
// rebuild and replays it against a live database. It does not cover an
// IF NOT EXISTS clause or irregular whitespace around CREATE TABLE:
// sqlite_schema always stores that part of a table's own declaration
// canonicalized (single spaces, upper case, IF NOT EXISTS dropped), so
// renamedCreate() -- whose only caller passes that stored text -- never
// actually sees either one (see its own comment in migration.ts). It also
// does not cover a single-quoted name: the regex has no case for it yet.
// The plain-name case matches a name such as 'qi' whole, so that rebuild
// works, but a single-quoted name that holds whitespace or "(", such as
// 'my table', makes the rebuild emit a CREATE statement that fails to execute.
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
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind !== "ok") return;
    assert.ok(plan.statements.some((s) => s.includes("_solarsql_new_")), JSON.stringify(plan.statements));
    for (const sql of plan.statements) current.exec(sql);
    assert.deepEqual(diff(introspect(current), introspect(target)), { kind: "ok", statements: [] });
  } finally {
    current.close();
    target.close();
  }
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
