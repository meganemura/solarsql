// The generated types are keyed by the SQL text. This test edits one query
// of the example without rebuilding, runs tsc on the copy, and expects the
// error at the changed string. The unedited copy is the control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tscArgs } from "./fixture-dir.ts";
import { copyExample } from "./copy-example.ts";

const root = resolve(import.meta.dirname, "..");

function tsc(dir: string): { status: number; output: string } {
  // dir is a copy of src/ and example/ only, with no node_modules/typescript
  // of its own, so this repository's root supplies tsc's own entry point.
  const [cmd, args] = tscArgs(root, ["-p", join(dir, "tsconfig.json")]);
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  const output = result.stdout !== undefined || result.stderr !== undefined
    ? (result.stdout ?? "") + (result.stderr ?? "")
    : (result.error?.message ?? "");
  return { status: result.status ?? -1, output };
}

test("a changed SQL string fails tsc at the call site until the build runs again", { timeout: 120_000 }, () => {
  const dir = copyExample();
  try {
    const control = tsc(dir);
    assert.equal(control.status, 0, control.output);

    const file = join(dir, "example/modules/orders/module.ts");
    const source = readFileSync(file, "utf8");
    const edited = source.replace("select id, customer_id, status, note from orders where id = :id", "select id, customer_id, status from orders where id = :id");
    assert.notEqual(edited, source);
    writeFileSync(file, edited);

    const stale = tsc(dir);
    assert.notEqual(stale.status, 0);
    assert.match(stale.output, /orders\/module\.ts/);
    assert.match(stale.output, /select id, customer_id, status from orders where id = :id/);
    assert.match(stale.output, /run npx solarsql build/);

    // The expected type at the catalog site is the remedy sentence, not the
    // union of every key of the generated map: the line naming the changed
    // literal must not also carry another query's SQL (order_lines, from
    // the withLines query) as an expected-type member (ADR 0126).
    const catalogLine = stale.output.split("\n").find((line) => line.includes("orders/module.ts"));
    assert.ok(catalogLine, stale.output);
    assert.doesNotMatch(catalogLine, /order_lines/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
