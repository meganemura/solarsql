// Responsibility: CLI exit codes and recovery commands across generation and checks.
// Boundary: schema inference and migration SQL have their own in-process tests.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = "example/team's $config.ts";
const quotedConfig = `'example/team'"'"'s $config.ts'`;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(root, "example"), join(dir, "example"), { recursive: true });
  renameSync(join(dir, "example/solarsql.config.ts"), join(dir, config));
  const module = join(dir, "example/modules/orders/module.ts");
  const generated = join(dir, "example/modules/orders/solarsql.generated.ts");
  return {
    dir,
    generated,
    edit(from: string, to: string) {
      const before = readFileSync(module, "utf8");
      assert.ok(before.includes(from));
      writeFileSync(module, before.replace(from, to));
    },
    run(...args: string[]) {
      const result = spawnSync(process.execPath, [join(dir, "src/build/cli.ts"), ...args, config], {
        cwd: dir, encoding: "utf8", timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
    runAfterRenameStarts(target: string, ...args: string[]) {
      const preload = join(dir, "stop-after-atomic-write.mjs");
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
      const result = spawnSync(process.execPath, ["--import", preload, join(dir, "src/build/cli.ts"), ...args, config], {
        cwd: dir, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, SOLARSQL_TEST_BLOCK_TARGET: target },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
    runWithExitDelay(delayMs: number, ...args: string[]) {
      const preload = join(dir, "delay-exit.mjs");
      writeFileSync(preload, [
        "const originalExit = process.exit.bind(process);",
        "process.exit = (code) => {",
        '  const delay = Number(process.env.SOLARSQL_TEST_EXIT_DELAY_MS ?? "0");',
        "  if (delay > 0) {",
        "    const until = Date.now() + delay;",
        "    while (Date.now() < until) { /* deliberately block the event loop, to model real work finishing just before the process actually closes */ }",
        "  }",
        "  return originalExit(code);",
        "};",
      ].join("\n"));
      const result = spawnSync(process.execPath, ["--import", preload, join(dir, "src/build/cli.ts"), ...args, config], {
        cwd: dir, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, SOLARSQL_TEST_EXIT_DELAY_MS: String(delayMs) },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

// Compare all project files so a check cannot silently update the migration index.
function snapshot(dir: string): [string, string][] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry): [string, string] => {
      const path = join(entry.parentPath, entry.name);
      return [path, readFileSync(path).toString("base64")];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

test("build generates changed SQL and check reports stale files without writes", (t) => {
  const f = fixture(t);
  f.edit("update orders set note = :note where id = :id", "update orders set note = :note where id = :id and status = 'draft'");
  const before = snapshot(f.dir);
  const checked = f.run("build", "--check");
  assert.equal(checked.status, 1, checked.stderr);
  assert.ok(checked.stderr.includes(`Run: npx solarsql build ${quotedConfig}`));
  assert.deepEqual(snapshot(f.dir), before);
  const built = f.run("build");
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /wrote\s+.*solarsql.generated.ts/);
  assert.match(readFileSync(f.generated, "utf8"), /status = 'draft'/);
  assert.equal(f.run("build", "--check").status, 0);
});

test("pending migration is a successful generation and a failed check", (t) => {
  const f = fixture(t);
  f.edit("updated_at text\n", "updated_at text,\n    placed_at integer not null default 0\n");
  f.edit("select id, note, updated_at from orders", "select id, note, updated_at, placed_at from orders");
  const before = snapshot(f.dir);
  const checked = f.run("build", "--check");
  assert.equal(checked.status, 1, checked.stderr);
  assert.deepEqual(snapshot(f.dir), before);
  const built = f.run("build");
  assert.equal(built.status, 0, built.stderr);
  assert.ok(built.stderr.includes(`migration pending. Write the migration: npx solarsql migration <name> ${quotedConfig}`));
  assert.match(readFileSync(f.generated, "utf8"), /placed_at/);
  assert.equal(f.run("build", "--check").status, 1);
  assert.equal(f.run("migration", "placed_at").status, 0);
  assert.equal(f.run("build", "--check").status, 0);
});

test("blocked migration preserves generated types and fails checks without writes", (t) => {
  const f = fixture(t);
  f.edit("updated_at text\n", "updated_at text,\n    placed_at integer not null\n");
  f.edit("select id, note, updated_at from orders", "select id, note, updated_at, placed_at from orders");
  const before = snapshot(f.dir);
  const checked = f.run("build", "--check");
  assert.equal(checked.status, 1, checked.stderr);
  assert.deepEqual(snapshot(f.dir), before);
  const built = f.run("build");
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stderr, /migration blocked: .*placed_at is NOT NULL without a default/);
  assert.ok(built.stderr.includes(`then run: npx solarsql build ${quotedConfig}`));
  assert.match(readFileSync(f.generated, "utf8"), /placed_at/);
  assert.equal(f.run("build", "--check").status, 1);
  assert.equal(f.run("migration", "placed_at").status, 1);
});

test("a removed ordinary column needs an exact intent before migration generation", (t) => {
  const f = fixture(t);
  const initial = join(f.dir, "example/migrations/0001_initial.sql");
  writeFileSync(initial, readFileSync(initial, "utf8").replace("    note text\n", "    note text,\n    obsolete_note text\n"));
  const before = snapshot(f.dir);
  const checked = f.run("build", "--check");
  assert.equal(checked.status, 1, checked.stderr);
  assert.match(checked.stderr, /migration blocked: automatic migration removes ordinary objects: column "orders"\."obsolete_note"/);
  assert.match(checked.stderr, /Create changes\.json:/);
  assert.match(checked.stderr, /npx solarsql migration describe_change --intent changes\.json/);
  assert.deepEqual(snapshot(f.dir), before);

  const intent = join(f.dir, "changes.json");
  writeFileSync(intent, JSON.stringify({ version: 1, drops: [{ kind: "column", table: "orders", column: "obsolete_note" }], renames: [] }));
  const written = f.run("migration", "remove_obsolete_note", "--intent", intent);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /wrote 0006_remove_obsolete_note\.sql/);
  assert.equal(f.run("build", "--check").status, 0);
});

test("a pending rename reports a strict intent and writes a data-preserving migration", (t) => {
  const f = fixture(t);
  const initial = join(f.dir, "example/migrations/0001_initial.sql");
  writeFileSync(initial, readFileSync(initial, "utf8").replace("    note text\n", '    "old.note" text\n'));
  const search = join(f.dir, "example/migrations/0004_search.sql");
  writeFileSync(search, readFileSync(search, "utf8").replaceAll("new.note", 'new."old.note"').replace("after update of note", 'after update of "old.note"'));
  const before = snapshot(f.dir);
  const checked = f.run("build", "--check");
  assert.equal(checked.status, 1, checked.stderr);
  assert.match(checked.stderr, /columns \[old\.note\] removed and \[note\] added/);
  assert.match(checked.stderr, /"renames": \[\n    \{\n      "table": "orders",\n      "from": "old.note",\n      "to": "note"/);
  assert.ok(checked.stderr.includes(quotedConfig));
  assert.deepEqual(snapshot(f.dir), before);
  const machine = f.run("build", "--check", "--json");
  assert.equal(machine.status, 1, machine.stderr);
  const report = JSON.parse(machine.stdout) as { result: { migration: { renames?: unknown; drops?: unknown } } };
  assert.deepEqual(report.result.migration.renames, [{ table: "orders", from: "old.note", to: "note" }]);
  assert.equal(report.result.migration.drops, undefined);
  assert.deepEqual(snapshot(f.dir), before);

  const intent = join(f.dir, "rename.json");
  writeFileSync(intent, JSON.stringify({ version: 1, drops: [], renames: [{ table: "orders", from: "old.note", to: "note" }] }));
  const written = f.run("migration", "rename_note", "--intent", intent);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /wrote 0006_rename_note\.sql/);
  assert.match(readFileSync(join(f.dir, "example/migrations/0006_rename_note.sql"), "utf8"), /rename column "old\.note" to "note"/);
  assert.equal(f.run("build", "--check").status, 0);
});

test("an invalid destructive intent fails before configuration import", (t) => {
  const f = fixture(t);
  const intent = join(f.dir, "invalid.json");
  writeFileSync(intent, '{"version":1,"drops":[],"renames":[],"unexpected":true}');
  writeFileSync(join(f.dir, config), "throw new Error('configuration must not load');\n");
  const result = f.run("migration", "remove", "--intent", intent);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid migration intent/);
  assert.doesNotMatch(result.stderr, /configuration must not load/);
});

test("an unreadable destructive intent fails before configuration import", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, config), "throw new Error('configuration must not load');\n");
  const result = f.run("migration", "remove", "--intent", join(f.dir, "missing.json"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid migration intent .*cannot read the file/);
  assert.doesNotMatch(result.stderr, /configuration must not load/);
});

test("invalid SQL fails generation and checks", (t) => {
  const f = fixture(t);
  f.edit("update orders set note = :note where id = :id", "update orders set absent_column = :note where id = :id");
  for (const args of [["build"], ["build", "--check"]]) {
    const result = f.run(...args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no such column: absent_column/);
  }
});

test("missing generated files retain the custom config in recovery commands without writes", (t) => {
  const f = fixture(t);
  rmSync(f.generated);
  for (const importsModule of [false, true]) {
    if (importsModule) {
      const path = join(f.dir, config);
      writeFileSync(path, `import { orderQueries } from "./modules/orders/public.ts";\nexport const queries = orderQueries;\n${readFileSync(path, "utf8")}`);
    }
    const before = snapshot(f.dir);
    const result = f.run("build", "--check");
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`is missing. Run: npx solarsql build ${quotedConfig}`), result.stderr);
    assert.deepEqual(snapshot(f.dir), before);
  }
});

test("a DDL-only nullability change updates types before its migration", (t) => {
  const f = fixture(t);
  assert.equal(f.run("build", "--check").status, 0);
  assert.match(readFileSync(f.generated, "utf8"), /updated_at: string \| null/);
  f.edit("updated_at text\n", "updated_at text not null default ''\n");
  const before = snapshot(f.dir);
  assert.equal(f.run("build", "--check").status, 1);
  assert.deepEqual(snapshot(f.dir), before);
  const built = f.run("build");
  assert.equal(built.status, 0, built.stderr);
  const generated = readFileSync(f.generated, "utf8");
  assert.match(generated, /updated_at: string[ };]/);
  assert.doesNotMatch(generated, /updated_at: string \| null/);
  assert.equal(f.run("build", "--check").status, 1);
  assert.equal(f.run("migration", "updated_at_required").status, 0);
  assert.equal(f.run("build", "--check").status, 0);
});

test('inspect reports contracts, sources and effects without modifying files', t => {
  const f = fixture(t);
  const before = snapshot(f.dir);
  const inspected = f.run('inspect');
  assert.equal(inspected.status, 0, inspected.stderr);
  const report = JSON.parse(inspected.stdout);
  assert.equal(report.version, 1);
  assert.equal(report.contract.deploymentVerified, false);
  const operations = report.result.inspection.operations as { sql: string; locations: string[]; columns: unknown[]; accesses: { action: string; table: string }[] }[];
  assert.ok(operations.some(o => o.locations.some(l => l.includes('orderQueries.byId')) && o.columns.length > 0));
  assert.ok(operations.some(o => o.accesses.some(a => a.action === 'update' && a.table === 'orders')));
  assert.deepEqual(snapshot(f.dir), before);
  f.edit('update orders set note = :note where id = :id', "update orders set note = :note where id = :id and status = 'draft'");
  const stale = f.run('inspect');
  assert.equal(stale.status, 1);
  assert.ok(JSON.parse(stale.stdout).diagnostics.some((d: { code: string }) => d.code === 'GENERATED_STALE'));
});

test('JSON failures retain SQL and source locations', t => {
  const f = fixture(t);
  f.edit('update orders set note = :note where id = :id', 'update orders set unknown_field = :note where id = :id');
  const before = snapshot(f.dir);
  for (const args of [['inspect'], ['build', '--check', '--json']]) {
    const result = f.run(...args);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.diagnostics[0].code, 'BUILD_FAILED');
    assert.match(report.diagnostics[0].sql, /unknown_field/);
    assert.ok(report.diagnostics[0].locations.some((l: string) => l.includes('module.ts')));
  }
  assert.deepEqual(snapshot(f.dir), before);
});

test('machine build reports survive configuration and module output', t => {
  const f = fixture(t);
  const path = join(f.dir, config);
  writeFileSync(path, `console.log('config log'); process.stdout.write('config direct\\n');\n` + readFileSync(path, 'utf8'));
  f.edit('import {', `console.log('module log'); process.stdout.write('module direct\\n');\nimport {`);
  const parse = (...args: string[]) => {
    const result = f.run(...args);
    for (const text of ['config log', 'config direct', 'module log', 'module direct']) assert.ok(result.stderr.includes(text), result.stderr);
    return { result, report: JSON.parse(result.stdout) };
  };
  for (const args of [['inspect'], ['build', '--json']]) {
    const { result, report } = parse(...args);
    assert.equal(result.status, 0);
    assert.equal(report.ok, true);
  }
  f.edit('update orders set note = :note where id = :id', "update orders set note = :note where id = :id and status = 'draft'");
  for (const args of [['inspect'], ['build', '--check', '--json']]) {
    const { result, report } = parse(...args);
    assert.equal(result.status, 1);
    assert.ok(report.diagnostics.some((d: {code: string}) => d.code === 'GENERATED_STALE'));
  }
  f.edit('update orders set note = :note', 'update orders set missing_column = :note');
  for (const args of [['inspect'], ['build', '--json']]) {
    const { result, report } = parse(...args);
    assert.equal(result.status, 1);
    assert.equal(report.diagnostics[0].code, 'BUILD_FAILED');
    assert.match(report.diagnostics[0].message, /missing_column/);
  }
});

test('machine imports report exceptions and premature successful exits as failures', t => {
  for (const ending of ["throw new Error('import exploded')", 'process.exit(0)']) {
    const f = fixture(t);
    const path = join(f.dir, config);
    writeFileSync(path, `console.log('before termination'); process.stdout.write('direct termination\\n'); ${ending};\n` + readFileSync(path, 'utf8'));
    for (const args of [['inspect'], ['build', '--json']]) {
      const result = f.run(...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /before termination/);
      assert.match(result.stderr, /direct termination/);
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.diagnostics[0].code, ending.startsWith('throw') ? 'BUILD_FAILED' : 'BUILD_WORKER_FAILED');
    }
  }
});

test('an unrelated IPC message from imported project code does not corrupt a machine report', t => {
  const f = fixture(t);
  const path = join(f.dir, config);
  writeFileSync(path, `if (typeof process.send === 'function') process.send({unrelated: true});\n` + readFileSync(path, 'utf8'));
  for (const args of [['inspect'], ['build', '--json']]) {
    const result = f.run(...args);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true, JSON.stringify(report));
  }
});

test('machine builds bound configuration imports before they run', t => {
  const f = fixture(t);
  const commands = [['inspect'], ['build', '--json']];
  const oneReport = (result: ReturnType<typeof f.run>) => {
    assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
    return JSON.parse(result.stdout) as { ok: boolean; diagnostics: { code: string; timeoutMs?: number; action?: string; message?: string }[] };
  };
  for (const args of commands) {
    const defaultResult = f.run(...args);
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    assert.equal(oneReport(defaultResult).ok, true);
    const override = f.run(...args, '--timeout-ms', '60000');
    assert.equal(override.status, 0, override.stderr);
    assert.equal(oneReport(override).ok, true);
  }
  f.edit('update orders set note = :note where id = :id', "update orders set note = :note where id = :id and status = 'draft'");
  const generated = f.run('build', '--json', '--timeout-ms', '60000');
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(oneReport(generated).ok, true);
  assert.match(readFileSync(f.generated, 'utf8'), /status = 'draft'/);
  const path = join(f.dir, config);
  writeFileSync(path, "console.error('deadline import started'); process.stdout.write('deadline import stdout\\n'); await new Promise<void>(() => { setInterval(() => {}, 1000); });\n");
  for (const args of commands) {
    const timed = f.run(...args, '--timeout-ms', '500');
    assert.equal(timed.status, 1, timed.stderr);
    assert.match(timed.stderr, /deadline import started/);
    assert.match(timed.stderr, /deadline import stdout/);
    const report = oneReport(timed);
    assert.equal(report.ok, false);
    assert.equal(report.diagnostics[0]!.code, 'BUILD_TIMEOUT');
    assert.equal(report.diagnostics[0]!.timeoutMs, 500);
    assert.match(report.diagnostics[0]!.action!, /--timeout-ms/);
  }
  writeFileSync(path, "console.error('invalid deadline imported'); throw new Error('the deadline parser imported this config');\n");
  for (const args of commands) {
    const invalid = f.run(...args, '--timeout-ms', '0');
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(invalid.stderr, /invalid deadline imported/);
    const report = oneReport(invalid);
    assert.equal(report.diagnostics[0]!.code, 'BUILD_FAILED');
    assert.match(report.diagnostics[0]!.message!, /requires an integer/);
  }
});

test('human build commands validate deadlines before imports and bound their direct worker', t => {
  const f = fixture(t);
  for (const args of [['build'], ['build', '--check'], ['migration', 'deadline_test']]) {
    const defaultResult = f.run(...args);
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    const override = f.run(...args, '--timeout-ms', '60000');
    assert.equal(override.status, 0, override.stderr);
  }
  const path = join(f.dir, config);
  writeFileSync(path, "console.error('human deadline import started'); process.stdout.write('human deadline stdout\\n'); await new Promise<void>(() => { setInterval(() => {}, 1000); });\n");
  for (const args of [['build'], ['build', '--check'], ['migration', 'deadline_test']]) {
    const timed = f.run(...args, '--timeout-ms', '500');
    assert.equal(timed.status, 1, timed.stderr);
    assert.match(timed.stderr, /human deadline import started/);
    assert.match(timed.stderr, /exceeded its 500ms time budget/);
    assert.match(timed.stderr, /--timeout-ms/);
  }
  writeFileSync(path, "console.error('human invalid deadline imported'); throw new Error('the parent imported this config');\n");
  for (const args of [['build'], ['build', '--check'], ['migration', 'deadline_test']]) {
    const invalid = f.run(...args, '--timeout-ms', '0');
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(invalid.stderr, /human invalid deadline imported/);
    assert.match(invalid.stderr, /requires an integer/);
  }
});

test('a machine report received before the child closes is not discarded as a timeout', t => {
  const f = fixture(t);
  // The report worker sends its report and then keeps the process open past
  // the deadline before it really exits. A parent that only clears its
  // timer on close would race the deadline and report a false timeout for
  // a build that had already finished and reported success.
  const timed = f.runWithExitDelay(1500, 'inspect', '--timeout-ms', '500');
  assert.equal(timed.status, 0, timed.stderr);
  const report = JSON.parse(timed.stdout);
  assert.equal(report.ok, true, JSON.stringify(report));
});

test('a human worker exit code received before the child closes is not discarded as a timeout', t => {
  const f = fixture(t);
  // The human worker finishes its real work and then keeps the process
  // open past the deadline before it really exits. A parent that only
  // clears its timer on close would race the deadline and report a false
  // timeout for a build that had already finished successfully.
  const timed = f.runWithExitDelay(1500, 'build', '--timeout-ms', '500');
  assert.equal(timed.status, 0, timed.stderr);
  assert.doesNotMatch(timed.stderr, /exceeded its 500ms time budget/);
});

test('human build timeout retains a complete generated destination when atomic replacement has started', t => {
  const f = fixture(t);
  const before = readFileSync(f.generated, "utf8");
  f.edit("update orders set note = :note where id = :id", "update orders set note = :note where id = :id and status = 'draft'");
  const timed = f.runAfterRenameStarts("solarsql.generated.ts", "build", "--timeout-ms", "500");
  assert.equal(timed.status, 1, timed.stderr);
  assert.match(timed.stderr, /atomic replacement started/);
  assert.match(timed.stderr, /exceeded its 500ms time budget/);
  assert.equal(readFileSync(f.generated, "utf8"), before);
  const temporary = readdirSync(join(f.dir, "example/modules/orders"))
    .filter(name => /^\.solarsql\.generated\.ts\.\d+\.[0-9a-f]+\.tmp$/.test(name));
  assert.equal(temporary.length, 1);
  assert.match(readFileSync(join(f.dir, "example/modules/orders", temporary[0]!), "utf8"), /status = 'draft'/);
});

test('migration timeout keeps the first retained lock after project code forges a later announcement', t => {
  const f = fixture(t);
  const index = join(f.dir, "example/migrations/index.ts");
  const before = readFileSync(index, "utf8");
  f.edit("updated_at text\n", "updated_at text,\n    placed_at integer not null default 0\n");
  f.edit("select id, note, updated_at from orders", "select id, note, updated_at, placed_at from orders");
  const configPath = join(f.dir, config);
  const forged = join(f.dir, "forged-lock");
  writeFileSync(configPath, [
    "const originalSend = process.send?.bind(process);",
    "process.on(\"message\", message => {",
    "  const value = message as { protocol?: string; token?: string; type?: string };",
    "  if (value.type === \"migration-lock-ack\") originalSend?.({ protocol: value.protocol, token: value.token, type: \"migration-lock\", nonce: \"forged\", path: " + JSON.stringify(forged) + " });",
    "});",
    'Object.defineProperty(process, "send", { value: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) });',
    "",
  ].join("\n") + readFileSync(configPath, "utf8"));
  const timed = f.runAfterRenameStarts("migrations/index.ts", "migration", "atomic_timeout", "--timeout-ms", "500");
  const lock = join(f.dir, "example/migrations/.solarsql-generation.lock");
  assert.equal(timed.status, 1, timed.stderr);
  assert.match(timed.stderr, /atomic replacement started/);
  assert.match(timed.stderr, new RegExp(lock.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(timed.stderr, new RegExp(forged.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")));
  assert.match(timed.stderr, /remove it only after this worker has stopped/);
  assert.doesNotMatch(timed.stderr, /current/);
  assert.ok(existsSync(lock));
  assert.equal(readFileSync(index, "utf8"), before);
  const temporary = readdirSync(join(f.dir, "example/migrations"))
    .filter(name => /^\.index\.ts\.\d+\.[0-9a-f]+\.tmp$/.test(name));
  assert.equal(temporary.length, 1);
  assert.match(readFileSync(join(f.dir, "example/migrations", temporary[0]!), "utf8"), /atomic_timeout/);
});

test('machine report transport flushes large diagnostics before exit', t => {
  const f = fixture(t);
  const message = 'failure: ' + 'x'.repeat(250_000);
  const path = join(f.dir, config);
  writeFileSync(path, `throw new Error(${JSON.stringify(message)});\n` + readFileSync(path, 'utf8'));
  const result = f.run('inspect');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].message, message);
});

test('rehearsal deadlines stop native SQL and remove snapshots while preserving WAL data', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-deadline-'));
  const temporary = join(dir, 'temporary');
  mkdirSync(temporary);
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec("pragma journal_mode=wal; create table items(value text); insert into items(rowid,value) values(42,'kept')");
  const before = [readFileSync(source), readFileSync(source + '-wal')];
  const change = join(dir, 'change.sql');
  const checks = join(dir, 'checks.json');
  writeFileSync(checks, JSON.stringify({ assertions: { retained: "select count(*)=1 and min(rowid)=42 and min(value)='kept' from items" } }));
  const observe = join(dir, 'observe.mjs');
  writeFileSync(observe, `import { subscribe } from 'node:diagnostics_channel'; subscribe('solarsql.rehearse', event => { if (event.phase === 'validate' && event.event === 'start') console.error('validation started'); });`);
  const run = (sql: string, ...options: string[]) => {
    writeFileSync(change, sql);
    const result = spawnSync(process.execPath, ['--import', observe, join(root, 'src/build/cli.ts'), 'rehearse', source, change, checks, ...options], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.deepEqual(readdirSync(temporary), []);
    assert.deepEqual([readFileSync(source), readFileSync(source + '-wal')], before);
    assert.equal(db.prepare('select rowid from items').get()!.rowid, 42);
    return { result, report: JSON.parse(result.stdout) };
  };
  for (const options of [[], ['--timeout-ms', '60000']]) {
    const { result, report } = run('alter table items add column extra text', ...options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.ok, true);
  }
  const failed = run('drop table missing_table');
  assert.equal(failed.result.status, 1);
  assert.equal(failed.report.diagnostics[0].code, 'MIGRATION_FAILED');
  const timed = run('with recursive forever(n) as (values(1) union all select n+1 from forever) select sum(n) from forever', '--timeout-ms', '2000');
  assert.match(timed.result.stderr, /validation started/);
  assert.equal(timed.result.status, 1);
  assert.equal(timed.report.ok, false);
  assert.equal(timed.report.diagnostics[0].code, 'REHEARSAL_TIMEOUT');
  assert.match(timed.report.diagnostics[0].action, /--timeout-ms/);
  for (const budget of ['0', '-1', '1.5', 'invalid', '2147483648']) {
    const invalid = run('select 1', '--timeout-ms', budget);
    assert.equal(invalid.result.status, 1);
    assert.match(invalid.report.diagnostics[0].message, /requires an integer/);
  }
});
