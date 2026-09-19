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
    rmSync(join(dir, "modules"), { recursive: true });
    // A migrations directory is a history, wrangler's or an earlier project's.
    mkdirSync(join(dir, "migrations"));
    writeFileSync(join(dir, "migrations/0001_theirs.sql"), "create table theirs (id integer primary key);\n");
    await assert.rejects(init("orders", dir), (e: unknown) => e instanceof BuildError && /migrations\/ exists/.test(e.message));
    assert.deepEqual(readdirSync(dir), ["migrations"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// init.ts normalizes relative() with .split("\\").join("/") because the
// paths it returns are printed and compared as project-relative POSIX
// paths on every platform: test/slow/pack.test.ts matches the CLI's
// "wrote   migrations/0001_initial.sql" output with a forward-slash regex
// (the `written` array), and this test matches the "exists" error message
// the same way. A success run of init() needs "solarsql" to resolve from
// the written config, which only the installed package gives (see the file
// header); that keeps `written`'s own no-backslash assertion out of this
// file too, and in pack.test.ts's existing regex match instead. node:path
// is imported at module scope in init.ts, not injected, so this test runs
// relative() on the current platform rather than a Windows-shaped one; the
// CI matrix's windows-latest job is what exercises the backslash-producing
// branch of node:path on every push.
test("the exists message contains no backslash", async () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, "modules/orders"), { recursive: true });
    writeFileSync(join(dir, "modules/orders/module.ts"), "// mine\n");
    await assert.rejects(init("orders", dir), (e: unknown) => e instanceof BuildError && !e.message.includes("\\"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
