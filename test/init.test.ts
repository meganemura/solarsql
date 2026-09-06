// `solarsql init` refuses to write over anything, and refuses a name that
// cannot be a table. The project it writes is tested in pack.test.ts, from
// the installed package, because that is where "solarsql" resolves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/build/init.ts";
import { BuildError } from "../src/build/typegen.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "solarsql-init-"));

test("a module name that cannot be a table is refused before anything is written", async () => {
  const dir = fresh();
  try {
    await assert.rejects(init("Order-Lines", dir), (e: unknown) => e instanceof BuildError && /module name must match/.test(e.message));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing file is never written over", async () => {
  const dir = fresh();
  try {
    writeFileSync(join(dir, "solarsql.config.ts"), "// mine\n");
    await assert.rejects(init("orders", dir), (e: unknown) => e instanceof BuildError && /solarsql\.config\.ts exists/.test(e.message));
    assert.equal(existsSync(join(dir, "modules")), false);
    rmSync(join(dir, "solarsql.config.ts"));
    mkdirSync(join(dir, "modules/orders"), { recursive: true });
    writeFileSync(join(dir, "modules/orders/module.ts"), "// mine\n");
    await assert.rejects(init("orders", dir), (e: unknown) => e instanceof BuildError && /modules\/orders\/module\.ts exists/.test(e.message));
    assert.equal(existsSync(join(dir, "solarsql.config.ts")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
