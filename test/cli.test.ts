// Responsibility: CLI exit codes and recovery commands across generation and checks.
// Boundary: schema inference and migration SQL have their own in-process tests.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
