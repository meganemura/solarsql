// The package as a user gets it: `npm pack`, install the tarball into a
// fresh project, run the CLI from node_modules, and import the adapters.
// This is the only test that needs the compiled dist/, and prepack builds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkDiscovery } from "./cli-discovery.ts";

const root = resolve(import.meta.dirname, "..");

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
    const invalid = "invalid-timeout.config.ts";
    writeFileSync(join(dir, "consumer", invalid), "console.error('packed invalid deadline import'); throw new Error('invalid deadline imported');\n");
    for (const args of [["inspect"], ["build", "--json"]]) {
      const rejected = machine(...args, "--timeout-ms", "0", invalid);
      assert.equal(rejected.result.status, 1);
      assert.doesNotMatch(rejected.result.stderr, /packed invalid deadline import/);
      assert.equal(rejected.report.diagnostics[0]!.code, "BUILD_FAILED");
      assert.match(rejected.report.diagnostics[0]!.message!, /requires an integer/);
    }

    // The generated file names the package, and is otherwise the committed one.
    const generated = readFileSync(join(dir, "consumer/example/modules/orders/solarsql.generated.ts"), "utf8");
    const committed = readFileSync(join(root, "example/modules/orders/solarsql.generated.ts"), "utf8");
    assert.equal(generated, committed.replace('from "../../../src/index.ts"', 'from "solarsql"'));

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
    const typed = spawnSync(join(root, "node_modules/.bin/tsc"), ["--noEmit", "-p", join(consumer, "tsconfig.json")], { cwd: consumer, encoding: "utf8" });
    assert.equal(typed.status, 0, typed.stdout + typed.stderr);
    // A second init in the same project is refused, and changes nothing.
    const again = spawnSync(cli, ["init", "orders"], { cwd: consumer, encoding: "utf8" });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /solarsql\.config\.ts exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
