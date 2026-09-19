// The package as a user gets it: `npm pack`, install the tarball into a
// fresh project, run the CLI from node_modules, and import the adapters.
// This is the only test that needs the compiled dist/, and prepack builds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkDiscovery } from "../cli-discovery.ts";
import { tscArgs } from "../fixture-dir.ts";

const root = resolve(import.meta.dirname, "../..");

// The example, with its relative imports of ../src turned into the package.
function writeConsumer(dir: string): void {
  const rewrite = (file: string) => {
    const text = readFileSync(file, "utf8")
      .replace(/from "(?:\.\.\/)+src\/index\.ts"/g, 'from "solarsql"')
      .replace(/from "(?:\.\.\/)+src\/(d1|durable)\.ts"/g, 'from "solarsql/$1"');
    writeFileSync(file, text);
  };
  cpSync(join(root, "example"), join(dir, "example"), { recursive: true });
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) rewrite(p);
    }
  };
  walk(join(dir, "example"));
  const config = join(dir, "example/solarsql.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace(/\n\s*library: "[^"]*",/, ""));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
}

test("npm pack, install, and run the CLI from node_modules", { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-pack-"));
  try {
    // On the machine that wrote this test, `npm pack` did not run the prepack
    // script (a wrapper around npm can pass --ignore-scripts), so dist/ is
    // built here. The test must never pack a stale or missing dist/.
    execFileSync("npm", ["run", "build", "--silent"], { cwd: root, encoding: "utf8" });
    const packOutput = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: root, encoding: "utf8" });
    const tarball = join(dir, packOutput.trim().split("\n").pop()!);
    assert.ok(existsSync(tarball), tarball);

    mkdirSync(join(dir, "consumer"));
    writeConsumer(join(dir, "consumer"));
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], { cwd: join(dir, "consumer"), encoding: "utf8" });

    // The installed package carries the source next to the compiled output.
    assert.ok(existsSync(join(dir, "consumer/node_modules/solarsql/src/index.ts")));
    assert.ok(existsSync(join(dir, "consumer/node_modules/solarsql/dist/index.js")));
    assert.ok(existsSync(join(dir, "consumer/node_modules/solarsql/skills/solarsql/SKILL.md")));

    const cli = join(dir, "consumer/node_modules/.bin/solarsql");
    checkDiscovery([cli], JSON.parse(readFileSync(join(dir, "consumer/node_modules/solarsql/package.json"), "utf8")).version);
    const machine = (...args: string[]) => {
      const result = spawnSync(cli, args, { cwd: join(dir, "consumer"), encoding: "utf8", timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout);
      return { result, report: JSON.parse(result.stdout) as { ok: boolean; diagnostics: { code: string; timeoutMs?: number; message?: string }[] } };
    };
    const built = spawnSync(cli, ["build", "example/solarsql.config.ts"], { cwd: join(dir, "consumer"), encoding: "utf8" });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    assert.match(built.stdout, /migrations are current/);
    for (const args of [["inspect"], ["build", "--json"]]) {
      const defaultResult = machine(...args, "example/solarsql.config.ts");
      assert.equal(defaultResult.result.status, 0, defaultResult.result.stderr);
      assert.equal(defaultResult.report.ok, true);
      const override = machine(...args, "--timeout-ms", "60000", "example/solarsql.config.ts");
      assert.equal(override.result.status, 0, override.result.stderr);
      assert.equal(override.report.ok, true);
    }
    const hanging = "hanging.config.ts";
    writeFileSync(join(dir, "consumer", hanging), "console.error('packed deadline import'); process.stdout.write('packed deadline stdout\\n'); await new Promise<void>(() => { setInterval(() => {}, 1000); });\n");
    for (const args of [["inspect"], ["build", "--json"]]) {
      const timed = machine(...args, "--timeout-ms", "500", hanging);
      assert.equal(timed.result.status, 1, timed.result.stderr);
      assert.match(timed.result.stderr, /packed deadline import/);
      assert.match(timed.result.stderr, /packed deadline stdout/);
      assert.equal(timed.report.diagnostics[0]!.code, "BUILD_TIMEOUT");
      assert.equal(timed.report.diagnostics[0]!.timeoutMs, 500);
    }
    for (const args of [["build"], ["build", "--check"], ["migration", "deadline_test"]]) {
      const timed = spawnSync(cli, [...args, "--timeout-ms", "500", hanging], { cwd: join(dir, "consumer"), encoding: "utf8", timeout: 10_000 });
      assert.ifError(timed.error);
      assert.equal(timed.status, 1, timed.stderr);
      assert.match(timed.stderr, /packed deadline import/);
      assert.match(timed.stderr, /exceeded its 500ms time budget/);
    }
    const invalid = "invalid-timeout.config.ts";
    writeFileSync(join(dir, "consumer", invalid), "console.error('packed invalid deadline import'); throw new Error('invalid deadline imported');\n");
    for (const args of [["inspect"], ["build", "--json"]]) {
      const rejected = machine(...args, "--timeout-ms", "0", invalid);
      assert.equal(rejected.result.status, 1);
      assert.doesNotMatch(rejected.result.stderr, /packed invalid deadline import/);
      assert.equal(rejected.report.diagnostics[0]!.code, "BUILD_FAILED");
      assert.match(rejected.report.diagnostics[0]!.message!, /requires an integer/);
    }
    for (const args of [["build"], ["build", "--check"], ["migration", "deadline_test"]]) {
      const rejected = spawnSync(cli, [...args, "--timeout-ms", "0", invalid], { cwd: join(dir, "consumer"), encoding: "utf8", timeout: 10_000 });
      assert.ifError(rejected.error);
      assert.equal(rejected.status, 1);
      assert.doesNotMatch(rejected.stderr, /packed invalid deadline import/);
      assert.match(rejected.stderr, /requires an integer/);
    }
    for (const args of [["build", "--check"], ["migration", "deadline_test"]]) {
      const result = spawnSync(cli, [...args, "--timeout-ms", "60000", "example/solarsql.config.ts"], { cwd: join(dir, "consumer"), encoding: "utf8", timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }

    // The generated file names the package, and is otherwise the committed one.
    const generated = readFileSync(join(dir, "consumer/example/modules/orders/solarsql.generated.ts"), "utf8");
    const committed = readFileSync(join(root, "example/modules/orders/solarsql.generated.ts"), "utf8");
    assert.equal(generated, committed.replace('from "../../../src/index.ts"', 'from "solarsql"'));

    const preload = join(dir, "consumer", "stop-after-atomic-write.mjs");
    writeFileSync(preload, [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const rename = fs.renameSync;",
      'fs.renameSync = (from, to) => {',
      '  if (String(to).endsWith(process.env.SOLARSQL_TEST_BLOCK_TARGET ?? "")) {',
      '    console.error("atomic replacement started: " + to);',
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
      "  }",
      "  return rename(from, to);",
      "};",
      "syncBuiltinESMExports();",
    ].join("\n"));
    // The worker blocks forever in process.send (Atomics.wait) once it
    // reaches the atomic write, so the deadline below is what ends the run;
    // the budget only needs to exceed a cold project import, not bound test
    // time. On a slow CI runner (run 35419887354, ubuntu, 2026-09-19) a
    // 500ms budget lost that race: the deadline fired before the worker
    // reached the atomic write, and the "atomic replacement started"
    // assertion failed. A cold `build --timeout-ms 60000` import on this
    // machine measured ~0.2s; 5000ms is well over 20x that with headroom
    // for a slower runner, and the spawnSync timeout below leaves room for
    // both the budget and process teardown.
    const atomicBudgetMs = 5_000;
    const atomicRun = (target: string, args: string[]) => spawnSync(cli, args, {
      cwd: join(dir, "consumer"), encoding: "utf8", timeout: atomicBudgetMs * 4,
      env: { ...process.env, NODE_OPTIONS: "--import=" + preload, SOLARSQL_TEST_BLOCK_TARGET: target },
    });
    const module = join(dir, "consumer/example/modules/orders/module.ts");
    const moduleBefore = readFileSync(module, "utf8");
    writeFileSync(module, moduleBefore.replace("update orders set note = :note where id = :id", "update orders set note = :note where id = :id and status = 'draft'"));
    const generatedPath = join(dir, "consumer/example/modules/orders/solarsql.generated.ts");
    const generatedBefore = readFileSync(generatedPath, "utf8");
    const outputTimeout = atomicRun("solarsql.generated.ts", ["build", "--timeout-ms", String(atomicBudgetMs), "example/solarsql.config.ts"]);
    assert.ifError(outputTimeout.error);
    assert.equal(outputTimeout.status, 1, outputTimeout.stderr);
    assert.match(outputTimeout.stderr, /atomic replacement started/);
    assert.equal(readFileSync(generatedPath, "utf8"), generatedBefore);
    const generatedTemporary = readdirSync(join(dir, "consumer/example/modules/orders"))
      .filter(name => /^\.solarsql\.generated\.ts\.\d+\.[0-9a-f]+\.tmp$/.test(name));
    assert.equal(generatedTemporary.length, 1);
    assert.match(readFileSync(join(dir, "consumer/example/modules/orders", generatedTemporary[0]!), "utf8"), /status = 'draft'/);

    const index = join(dir, "consumer/example/migrations/index.ts");
    const indexBefore = readFileSync(index, "utf8");
    writeFileSync(module, readFileSync(module, "utf8")
      .replace("updated_at text\n", "updated_at text,\n    placed_at integer not null default 0\n")
      .replace("select id, note, updated_at from orders", "select id, note, updated_at, placed_at from orders"));
    const configPath = join(dir, "consumer/example/solarsql.config.ts");
    const forged = join(dir, "consumer/forged-lock");
    writeFileSync(configPath, [
      "const originalSend = process.send?.bind(process);",
      "process.on(\"message\", message => {",
      "  const value = message as { protocol?: string; token?: string; type?: string };",
      "  if (value.type === \"migration-lock-ack\") originalSend?.({ protocol: value.protocol, token: value.token, type: \"migration-lock\", nonce: \"forged\", path: " + JSON.stringify(forged) + " });",
      "});",
      'Object.defineProperty(process, "send", { value: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) });',
      "",
    ].join("\n") + readFileSync(configPath, "utf8"));
    const migrationTimeout = atomicRun("migrations/index.ts", ["migration", "atomic_timeout", "--timeout-ms", String(atomicBudgetMs), "example/solarsql.config.ts"]);
    const lock = join(dir, "consumer/example/migrations/.solarsql-generation.lock");
    assert.ifError(migrationTimeout.error);
    assert.equal(migrationTimeout.status, 1, migrationTimeout.stderr);
    assert.match(migrationTimeout.stderr, /atomic replacement started/);
    assert.match(migrationTimeout.stderr, new RegExp(lock.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(migrationTimeout.stderr, new RegExp(forged.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")));
    assert.match(migrationTimeout.stderr, /remove it only after this worker has stopped/);
    assert.doesNotMatch(migrationTimeout.stderr, /current/);
    assert.ok(existsSync(lock));
    assert.equal(readFileSync(index, "utf8"), indexBefore);
    const indexTemporary = readdirSync(join(dir, "consumer/example/migrations"))
      .filter(name => /^\.index\.ts\.\d+\.[0-9a-f]+\.tmp$/.test(name));
    assert.equal(indexTemporary.length, 1);
    assert.match(readFileSync(join(dir, "consumer/example/migrations", indexTemporary[0]!), "utf8"), /atomic_timeout/);
    writeFileSync(module, moduleBefore);
    writeFileSync(generatedPath, generatedBefore);
    writeFileSync(index, indexBefore);
    for (const name of [...generatedTemporary, ...indexTemporary]) {
      const parent = name.startsWith(".index") ? join(dir, "consumer/example/migrations") : join(dir, "consumer/example/modules/orders");
      rmSync(join(parent, name));
    }
    rmSync(lock);
    for (const name of readdirSync(join(dir, "consumer/example/migrations"))) {
      if (name.endsWith("_atomic_timeout.sql")) rmSync(join(dir, "consumer/example/migrations", name));
    }

    const imported = spawnSync(process.execPath, ["-e", 'import("solarsql/d1").then((m) => console.log(typeof m.d1)); import("solarsql/durable").then((m) => console.log(typeof m.migrate)); import("solarsql/node").then((m) => console.log(typeof m.node)); import("solarsql").then((m) => console.log(typeof m.newId));'], {
      cwd: join(dir, "consumer"),
      encoding: "utf8",
    });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.trim().split("\n").sort().join(","), "function,function,function,function");

    // From zero: init writes a module, builds it, and writes the first
    // migration; the module's test runs on node:sqlite, and tsc accepts what
    // init wrote. The consumer's root has no configuration yet.
    const consumer = join(dir, "consumer");
    const inited = spawnSync(cli, ["init", "order_lines"], { cwd: consumer, encoding: "utf8" });
    assert.equal(inited.status, 0, inited.stdout + inited.stderr);
    assert.match(inited.stdout, /wrote   migrations\/0001_initial\.sql/);
    assert.match(inited.stdout, /wrote   tsconfig\.json/);
    assert.match(readFileSync(join(consumer, "modules/order_lines/solarsql.generated.ts"), "utf8"), /OrderLinesId/);
    // Under `node --test`, a child node inherits NODE_TEST_CONTEXT and would
    // report to this runner instead of its stdout.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    // Bare, as the README says: the default pattern finds the .ts test.
    const tested = spawnSync(process.execPath, ["--test"], { cwd: consumer, encoding: "utf8", env });
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    assert.match(tested.stdout, /^ℹ pass 1$/m);
    // tsc and @types/node from this repository, so the check needs no network.
    symlinkSync(join(root, "node_modules/@types"), join(consumer, "node_modules/@types"), "dir");
    const [tscCmd, tscCmdArgs] = tscArgs(root, ["--noEmit", "-p", join(consumer, "tsconfig.json")]);
    const typed = spawnSync(tscCmd, tscCmdArgs, { cwd: consumer, encoding: "utf8" });
    assert.equal(typed.status, 0, typed.stdout + typed.stderr);
    // A second init in the same project is refused, and changes nothing.
    const again = spawnSync(cli, ["init", "orders"], { cwd: consumer, encoding: "utf8" });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /solarsql\.config\.ts exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
