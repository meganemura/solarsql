// Responsibility: prove parseMigrationIntent's shape check itself, one
// defect and one exact message at a time, and prove readMigrationIntent's
// two failure paths (a read failure, and a parse failure) keep or replace
// the error as documented. Boundary: the diff between a parsed intent and a
// real schema change is covered in destructive-migration.test.ts and
// rename-intent.test.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseMigrationIntent, readMigrationIntent } from "../src/build/migration-intent.ts";
import { BuildError } from "../src/build/typegen.ts";

function invalid(text: string, message: string, path?: string): void {
  try {
    path === undefined ? parseMigrationIntent(text) : parseMigrationIntent(text, path);
    assert.fail(`expected ${text} to be rejected`);
  } catch (error) {
    assert.ok(error instanceof BuildError, `expected a BuildError, got ${String(error)}`);
    assert.equal((error as BuildError).message, `Invalid migration intent ${path ?? "intent"}: ${message}`);
  }
}

test("a syntax error is reported at the default path with the exact JSON message", () => {
  invalid("not json", "the file must contain JSON.");
  invalid("not json", "the file must contain JSON.", "config/intent.json");
});

test("the root must be exactly a version, a drops array, and a renames array", () => {
  const usage = 'use exactly {"version":1,"drops":[],"renames":[]}.';
  invalid('{"drops":[],"renames":[]}', usage);
  invalid('{"version":1,"drops":[],"renames":[],"extra":1}', usage);
  invalid('{"version":2,"drops":[],"renames":[]}', usage);
  invalid('{"version":1,"drops":{},"renames":[]}', usage);
  invalid('{"version":1,"drops":[],"renames":{}}', usage);
  invalid("null", usage);
  invalid('"a string"', usage);
});

test("a well-formed root with empty arrays parses to an empty intent", () => {
  assert.deepEqual(parseMigrationIntent('{"version":1,"drops":[],"renames":[]}'), { drops: [], renames: [] });
});

test("a table drop must be a plain object naming a table with a non-empty string", () => {
  const valid = '{"kind":"table","table":"kept"}';
  const message = (index: number) => `drops[${index}] must name a table or column.`;
  invalid(`{"version":1,"drops":[${valid},[1,2]],"renames":[]}`, message(1));
  invalid(`{"version":1,"drops":[${valid},{"table":"t"}],"renames":[]}`, message(1));
  invalid(`{"version":1,"drops":[${valid},{"kind":5,"table":"t"}],"renames":[]}`, message(1));
  invalid(`{"version":1,"drops":[${valid},{"kind":"table"}],"renames":[]}`, message(1));
  invalid(`{"version":1,"drops":[${valid},{"kind":"table","table":5}],"renames":[]}`, message(1));
  invalid(`{"version":1,"drops":[${valid},{"kind":"table","table":""}],"renames":[]}`, message(1));
});

test("a table drop with the exact kind and table shape parses to a table drop", () => {
  assert.deepEqual(parseMigrationIntent('{"version":1,"drops":[{"kind":"table","table":"retired"}],"renames":[]}'), {
    drops: [{ kind: "table", table: "retired" }],
    renames: [],
  });
});

test("a table or column drop with an unrecognized shape is named by its unknown shape message", () => {
  const message = (index: number) => `drops[${index}] has an unknown or incomplete object shape.`;
  invalid('{"version":1,"drops":[{"kind":"virtual","table":"search"}],"renames":[]}', message(0));
  invalid('{"version":1,"drops":[{"kind":"table","table":"t","extra":1}],"renames":[]}', message(0));
  invalid('{"version":1,"drops":[{"kind":"column","table":"t"}],"renames":[]}', message(0));
  invalid('{"version":1,"drops":[{"kind":"column","table":"t","column":""}],"renames":[]}', message(0));
  invalid('{"version":1,"drops":[{"kind":"column","table":"t","column":["x"]}],"renames":[]}', message(0));
  invalid('{"version":1,"drops":[{"kind":"column","table":"t","column":"c","extra":1}],"renames":[]}', message(0));
  invalid('{"version":1,"drops":[{"kind":"virtual","table":"t","column":"c"}],"renames":[]}', message(0));
});

test("a column drop with the exact kind, table, and column shape parses to a column drop", () => {
  assert.deepEqual(parseMigrationIntent('{"version":1,"drops":[{"kind":"column","table":"t","column":"c"}],"renames":[]}'), {
    drops: [{ kind: "column", table: "t", column: "c" }],
    renames: [],
  });
});

test("a rename must be a plain object with a non-empty string table, from, and to", () => {
  const valid = '{"table":"t","from":"a","to":"b"}';
  const message = (index: number) => `renames[${index}] must have string table, from, and to values.`;
  invalid(`{"version":1,"drops":[],"renames":[${valid},[1,2]]}`, message(1));
  invalid(`{"version":1,"drops":[],"renames":[${valid},{"from":"a","to":"b"}]}`, message(1));
  invalid(`{"version":1,"drops":[],"renames":[${valid},{"table":5,"from":"a","to":"b"}]}`, message(1));
  invalid(`{"version":1,"drops":[],"renames":[${valid},{"table":"t","from":5,"to":"b"}]}`, message(1));
  invalid(`{"version":1,"drops":[],"renames":[${valid},{"table":"t","from":"a","to":5}]}`, message(1));
  invalid(`{"version":1,"drops":[],"renames":[${valid},{"table":"","from":"a","to":"b"}]}`, message(1));
  invalid(`{"version":1,"drops":[],"renames":[${valid},{"table":"t","from":"","to":"b"}]}`, message(1));
  invalid(`{"version":1,"drops":[],"renames":[${valid},{"table":"t","from":"a","to":""}]}`, message(1));
  invalid(`{"version":1,"drops":[],"renames":[${valid},{"table":"t","from":"a","to":"b","extra":1}]}`, message(1));
});

test("a rename with the exact table, from, and to shape parses to a rename", () => {
  assert.deepEqual(parseMigrationIntent('{"version":1,"drops":[],"renames":[{"table":"t","from":"a","to":"b"}]}'), {
    drops: [],
    renames: [{ table: "t", from: "a", to: "b" }],
  });
});

test("readMigrationIntent parses a well-formed intent file at its own path", () => {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-migration-intent-"));
  try {
    const path = join(dir, "intent.json");
    writeFileSync(path, '{"version":1,"drops":[{"kind":"table","table":"retired"}],"renames":[]}');
    assert.deepEqual(readMigrationIntent(path), { drops: [{ kind: "table", table: "retired" }], renames: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readMigrationIntent rethrows a malformed file's own BuildError unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-migration-intent-"));
  try {
    const path = join(dir, "intent.json");
    writeFileSync(path, "not json");
    try {
      readMigrationIntent(path);
      assert.fail("expected readMigrationIntent to throw");
    } catch (error) {
      assert.ok(error instanceof BuildError, `expected a BuildError, got ${String(error)}`);
      assert.equal((error as BuildError).message, `Invalid migration intent ${path}: the file must contain JSON.`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readMigrationIntent wraps a missing file's read failure with the file's own path", () => {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-migration-intent-"));
  try {
    const path = join(dir, "missing.json");
    try {
      readMigrationIntent(path);
      assert.fail("expected readMigrationIntent to throw");
    } catch (error) {
      assert.ok(error instanceof BuildError, `expected a BuildError, got ${String(error)}`);
      const message = (error as BuildError).message;
      assert.ok(message.startsWith(`Invalid migration intent ${path}: cannot read the file (`), message);
      assert.ok(message.endsWith(")."), message);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a well-formed intent with reordered keys parses the same regardless of the key order in the JSON text", () => {
  let cases = 0;
  hegel.test(tc => {
    cases++;
    const table = tc.draw(gs.text({ minSize: 1, maxSize: 8 }).map(s => s.replace(/["\\]/g, "x") || "t"));
    const column = tc.draw(gs.text({ minSize: 1, maxSize: 8 }).map(s => s.replace(/["\\]/g, "x") || "c"));
    const drop = { kind: "column" as const, table, column };
    const rename = { to: "y", from: "x", table };
    const forward = { version: 1, drops: [drop], renames: [rename] };
    const reordered = { renames: [{ table: rename.table, to: rename.to, from: rename.from }], version: 1, drops: [{ table: drop.table, column: drop.column, kind: drop.kind }] };
    assert.deepEqual(parseMigrationIntent(JSON.stringify(forward)), parseMigrationIntent(JSON.stringify(reordered)));
  }, { testCases: 50 });
  console.log("migration intent key-order cases:", cases);
});
