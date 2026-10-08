// Responsibility: prove that the architecture policy rejects forbidden imports.
// Boundary: simulate complete source files without changing the checkout.
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../node_modules/archstrict/dist/cli.js", import.meta.url));

const cases = [
  {
    name: "an adapter cannot import compiler types",
    path: "src/d1.ts",
    statement: 'import type { Engine } from "./build/facts.ts";',
    rule: "tag-boundary",
    pointer: "edges.allowDeny[0].allow",
  },
  {
    name: "the runtime cannot import compiler types",
    path: "src/runtime/plan.ts",
    statement: 'import type { ColumnFact } from "../build/facts.ts";',
    rule: "point-rule",
    pointer: "edges.point[1]",
  },
  {
    name: "a Worker adapter cannot import a Node builtin",
    path: "src/d1.ts",
    statement: 'import { performance } from "node:perf_hooks";',
    rule: "point-rule",
    pointer: "edges.point[0]",
  },
  {
    name: "shared SQL text cannot import Node builtin types",
    path: "src/build/scan.ts",
    statement: 'import type { Performance } from "node:perf_hooks";',
    rule: "point-rule",
    pointer: "edges.point[0]",
  },
];

// archstrict 0.1.0 reports false surface bypasses on Windows.
for (const proof of cases) {
  test.skipIf(process.platform === "win32")(proof.name, () => {
    const file = new URL(`../../${proof.path}`, import.meta.url);
    const content = `${proof.statement}\n${readFileSync(file, "utf8")}`;
    const child = spawnSync(process.execPath, [cli, "simulate", "--json"], {
      cwd: root,
      input: JSON.stringify({ changes: [{ path: proof.path, content }] }),
      encoding: "utf8",
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1, child.stderr || child.stdout);
    const result: unknown = JSON.parse(child.stdout);
    assert.ok(typeof result === "object" && result !== null && "added" in result && Array.isArray(result.added));
    const added: unknown[] = result.added;
    assert.ok(added.some(violation => {
      if (typeof violation !== "object" || violation === null) return false;
      if (!("rule" in violation) || violation.rule !== proof.rule) return false;
      if (!("path" in violation) || violation.path !== fileURLToPath(file)) return false;
      if (!("config" in violation) || typeof violation.config !== "object" || violation.config === null) return false;
      return "pointer" in violation.config && violation.config.pointer === proof.pointer;
    }), child.stdout);
  });
}
