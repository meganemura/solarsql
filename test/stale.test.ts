// The generated types are keyed by the SQL text. This test edits one query
// of the example without rebuilding, runs tsc on the copy, and expects the
// error at the changed string. The unedited copy is the control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// A copy of src/ and example/ that keeps their relative layout.
export function copyExample(): string {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-"));
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(root, "example"), join(dir, "example"), { recursive: true });
  // The copy is an ES module project, like the repository.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "solarsql-copy", private: true, type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "nodenext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        erasableSyntaxOnly: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        types: ["node"],
        typeRoots: [join(root, "node_modules", "@types")],
      },
      include: ["src", "example"],
    }),
  );
  return dir;
}

function tsc(dir: string): { status: number; output: string } {
  const result = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
  return { status: result.status ?? -1, output: result.stdout + result.stderr };
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
