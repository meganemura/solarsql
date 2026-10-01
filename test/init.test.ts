// `solarsql init` refuses to write over anything, and refuses a name that
// cannot be a table. A local source package exercises the files in-process;
// pack.test.ts also tests them through the installed package.
import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, initEmpty } from "../src/build/init.ts";
import { BuildError } from "../src/build/typegen.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { node, migrate } from "../src/node.ts";
import { commands, queries } from "../src/index.ts";

// Resolve the source package in each isolated project without a pack or a build.
function sourcePackage(dir: string, packageAtMigration?: { type: string }): void {
  const pkg = join(dir, "node_modules/solarsql");
  mkdirSync(pkg, { recursive: true });
  symlinkSync(fileURLToPath(new URL("../src", import.meta.url)), join(pkg, "src"), "dir");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "solarsql", type: "module", exports: { ".": packageAtMigration ? "./entry.js" : "./src/index.ts", "./node": "./src/node.ts" },
  }));
  if (packageAtMigration) {
    // A configuration import can change files. The notice must read their final state.
    writeFileSync(join(pkg, "entry.js"), `
      export * from "./src/index.ts";
      import { config as declare } from "./src/index.ts";
      import { writeFileSync } from "node:fs";
      let calls = 0;
      export function config(value) {
        if (++calls === 2) writeFileSync(${JSON.stringify(join(dir, "package.json"))}, ${JSON.stringify(JSON.stringify(packageAtMigration))});
        return declare(value);
      }
    `);
    const moduleDir = join(dir, "modules/items");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "package.json"), '{"type":"module"}');
  }
}

const fresh = () => mkdtempSync(join(tmpdir(), "solarsql-init-"));

test("invalid suffixes are refused before any project file is written", async () => {
  const { testAsync } = await import("@hegeldev/hegel");
  const gs = await import("@hegeldev/hegel/generators");
  await testAsync(async tc => {
    const name = tc.draw(gs.fromRegex("[a-z][a-z0-9_]*"));
    const suffix = tc.draw(gs.sampledFrom(["-", ".", "/", " ", "A", "!", "\nextra"]));
    const dir = fresh();
    try {
      await assert.rejects(init(name + suffix, dir), /module name must match/);
      assert.deepEqual(readdirSync(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("init writes a usable order_lines module and reports every output", async () => {
  const dir = fresh();
  try {
    sourcePackage(dir);
    const result = await init("order_lines", dir);
    assert.deepEqual(result, {
      written: ["solarsql.config.ts", "modules/order_lines/module.ts", "modules/order_lines/public.ts",
        "modules/order_lines/module.test.ts", "tsconfig.json", "modules/order_lines/solarsql.generated.ts",
        "migrations/index.ts", "migrations/0001_initial.sql"],
      migration: "0001_initial.sql", notice: null, notes: [],
    });
    for (const path of result.written) assert.ok(readFileSync(join(dir, path), "utf8").length > 0, path);
    const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8"));
    assert.equal(tsconfig.compilerOptions.allowImportingTsExtensions, true);
    const catalogs = await import(pathToFileURL(join(dir, "modules/order_lines/public.ts")).href);
    // The first build imports a stub. Rebind its plans to the emitted metadata.
    const { generated } = await import(pathToFileURL(join(dir, "modules/order_lines/solarsql.generated.ts")).href + "?complete");
    const boundCommands = commands(generated, catalogs.orderLinesCommands.entries);
    const boundQueries = queries(generated, { all: catalogs.orderLinesQueries.all.sql });
    const raw = new DatabaseSync(":memory:");
    try {
      const history = await import(pathToFileURL(join(dir, "migrations/index.ts")).href);
      migrate(raw, history.migrations);
      const db = node(raw);
      assert.deepEqual(await db.run(boundCommands.create!, { id: "one", name: "first" }),
        { ok: true, rows: [{ id: "one", name: "first", done: 0 }], changes: 1 });
      assert.equal((await db.run(boundCommands.finish!, { id: "one" })).ok, true);
      assert.deepEqual(await db.run(boundCommands.finish!, { id: "one" }),
        { ok: false, kind: "assert", assert: "was_open" });
      assert.deepEqual(await db.all(boundQueries.all), [{ id: "one", name: "first", done: 1 }]);
    } finally { raw.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init preserves existing tsconfig bytes, notes allowImportingTsExtensions set to false, and adds no note when it is true", async () => {
  for (const enabled of [false, true]) {
    const dir = fresh();
    try {
      sourcePackage(dir);
      const text = JSON.stringify({ compilerOptions: { allowImportingTsExtensions: enabled } });
      writeFileSync(join(dir, "tsconfig.json"), text);
      const result = await init("items", dir);
      assert.equal(readFileSync(join(dir, "tsconfig.json"), "utf8"), text);
      assert.equal(result.written.includes("tsconfig.json"), false);
      assert.deepEqual(result.notes, enabled ? [] : [extensionNote]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("init reports no new migration when a generated-file import supplies matching history", async () => {
  const dir = fresh();
  try {
    sourcePackage(dir);
    const moduleDir = join(dir, "modules/items");
    mkdirSync(moduleDir, { recursive: true });
    // This file is imported after the initial history check. Its import creates
    // the schema that migration() later compares with the placeholder.
    const sql = `create table items (
      id text primary key not null, name text not null,
      done integer not null default 0 check (done in (0, 1))
    ) strict;
    CREATE TABLE solarsql_assert (name text not null, ok integer not null) strict;
    CREATE TRIGGER solarsql_assert_check before insert on solarsql_assert
      when new.ok = 0 BEGIN select raise(abort, new.name); END;`;
    writeFileSync(join(moduleDir, "solarsql.generated.ts"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync(new URL("../../migrations/", import.meta.url), { recursive: true });
      writeFileSync(new URL("../../migrations/0001_prior.sql", import.meta.url), ${JSON.stringify(sql)});
      export const generated = {};
    `);
    const result = await init("items", dir);
    assert.equal(result.migration, null);
    assert.deepEqual(result.written, ["solarsql.config.ts", "modules/items/module.ts", "modules/items/public.ts",
      "modules/items/module.test.ts", "tsconfig.json", "modules/items/solarsql.generated.ts", "migrations/index.ts"]);
    assert.deepEqual(readdirSync(join(dir, "migrations")).sort(), ["0001_prior.sql", "index.ts"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init skips the tsconfig note when an import replaces a newly created tsconfig", async () => {
  const dir = fresh();
  try {
    sourcePackage(dir);
    const moduleDir = join(dir, "modules/items");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "solarsql.generated.ts"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(new URL("../../tsconfig.json", import.meta.url), "{}");
      export const generated = {};
    `);
    const result = await init("items", dir);
    assert.equal(readFileSync(join(dir, "tsconfig.json"), "utf8"), "{}");
    assert.ok(result.written.includes("tsconfig.json"));
    assert.deepEqual(result.notes, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const extensionNote = 'tsconfig.json lacks allowImportingTsExtensions; the generated imports use .ts extensions. See skills/solarsql/references/deploy.md, "An existing Workers project".';

test("the extension note follows the flag through comments, an empty object, and null compilerOptions, and unreadable JSON adds no note", async () => {
  for (const [text, notes] of [
    ['{/* a multi-word\n block comment */"compilerOptions":{}}', [extensionNote]],
    ['{// a multi-word line comment\n"compilerOptions":{}}', [extensionNote]],
    ['{/* a multi-word\n block comment */"compilerOptions":{"allowImportingTsExtensions":true}}', []],
    ['{// a multi-word line comment\n"compilerOptions":{"allowImportingTsExtensions":true}}', []],
    ['{}', [extensionNote]],
    ['{"compilerOptions":null}', [extensionNote]],
    ['not JSON', []],
  ] as const) {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "tsconfig.json"), text);
      assert.deepEqual((await initEmpty(dir)).notes, notes);
      assert.equal(readFileSync(join(dir, "tsconfig.json"), "utf8"), text);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("comment contents do not change the extension flag decision", async () => {
  const { testAsync } = await import("@hegeldev/hegel");
  const gs = await import("@hegeldev/hegel/generators");
  await testAsync(async tc => {
    // Avoid a closing delimiter and nested block markers in the comment itself.
    const content = tc.draw(gs.text()).replace(/\*/g, " ");
    const enabled = tc.draw(gs.booleans());
    const comment = tc.draw(gs.booleans()) ? `/*${content}*/`
      : `//${content.replace(/[\r\n\u2028\u2029]/g, "\n//")}\n`;
    const text = `{${comment}"compilerOptions":{"allowImportingTsExtensions":${enabled}}}`;
    const dir = fresh();
    try {
      writeFileSync(join(dir, "tsconfig.json"), text);
      assert.deepEqual((await initEmpty(dir)).notes, enabled ? [] : [extensionNote]);
      assert.equal(readFileSync(join(dir, "tsconfig.json"), "utf8"), text);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("init returns no package notice for other package types or no package", async () => {
  for (const pkg of [undefined, {}, { type: "module" }, { type: "" }]) {
    const dir = fresh();
    try {
      sourcePackage(dir);
      if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
      const result = await init("items", dir);
      assert.equal(result.notice, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("init reports a package changed to commonjs during the migration import", async () => {
  const dir = fresh();
  try {
    sourcePackage(dir, { type: "commonjs" });
    const result = await init("items", dir);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), '{"type":"commonjs"}');
    assert.equal(result.notice, 'package.json says "type": "commonjs"; set it to "module" so node runs the .ts files');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init refuses existing public and test files with their project paths", async () => {
  for (const name of ["public.ts", "module.test.ts"]) {
    const dir = fresh();
    try {
      mkdirSync(join(dir, "modules/items"), { recursive: true });
      const path = join(dir, "modules/items", name);
      writeFileSync(path, "// keep\n");
      await assert.rejects(init("items", dir), {
        message: `modules/items/${name} exists. init is for a project without one; add a module by hand, as the README shows.`,
      });
      assert.equal(readFileSync(path, "utf8"), "// keep\n");
      assert.equal(existsSync(join(dir, "solarsql.config.ts")), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("init --empty refuses an existing migration history before writing files", async () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, "migrations"));
    writeFileSync(join(dir, "migrations/0001_old.sql"), "select 1;");
    await assert.rejects(initEmpty(dir), {
      message: "migrations/ exists. init writes the first migration; a project with a history adds a module by hand, as the README shows.",
    });
    assert.deepEqual(readdirSync(dir), ["migrations"]);
    assert.equal(readFileSync(join(dir, "migrations/0001_old.sql"), "utf8"), "select 1;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init --empty creates the migrations directory below a missing project root", async () => {
  const dir = fresh();
  try {
    const root = join(dir, "nested/project");
    assert.deepEqual((await initEmpty(root)).written, ["solarsql.config.ts", "tsconfig.json", "migrations/index.ts"]);
    assert.ok(existsSync(join(root, "migrations/index.ts")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
// the same way. The source-package fixture also checks the complete written
// paths after a successful init(). node:path is imported at module scope
// in init.ts, not injected, so this test runs
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

test("init --empty writes exactly config, tsconfig, and an empty migrations index", async () => {
  const dir = fresh();
  try {
    const result = await initEmpty(dir);
    assert.deepEqual(result.written, ["solarsql.config.ts", "tsconfig.json", "migrations/index.ts"]);
    assert.equal(existsSync(join(dir, "modules")), false);
    assert.equal(readdirSync(join(dir, "migrations")).length, 1);
    assert.match(readFileSync(join(dir, "solarsql.config.ts"), "utf8"), /modules: \[\]/);
    assert.match(readFileSync(join(dir, "migrations/index.ts"), "utf8"), /export const migrations = \[\n\] as const;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second init --empty refuses on the existing config, the same as init", async () => {
  const dir = fresh();
  try {
    await initEmpty(dir);
    await assert.rejects(initEmpty(dir), (e: unknown) => e instanceof BuildError && /solarsql\.config\.ts exists/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tsconfig without allowImportingTsExtensions gets a note; with it, no note", async () => {
  const withoutFlag = fresh();
  const withFlag = fresh();
  try {
    writeFileSync(join(withoutFlag, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    const missing = await initEmpty(withoutFlag);
    assert.deepEqual(missing.notes, [
      'tsconfig.json lacks allowImportingTsExtensions; the generated imports use .ts extensions. See skills/solarsql/references/deploy.md, "An existing Workers project".',
    ]);
    assert.equal(existsSync(join(withoutFlag, "tsconfig.json")), true);

    writeFileSync(join(withFlag, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true } }));
    const present = await initEmpty(withFlag);
    assert.deepEqual(present.notes, []);
  } finally {
    rmSync(withoutFlag, { recursive: true, force: true });
    rmSync(withFlag, { recursive: true, force: true });
  }
});
