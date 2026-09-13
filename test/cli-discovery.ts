// Responsibility: verify command discovery against source and installed CLIs.
// Boundary: application operations have separate integration tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function checkDiscovery(invocation: string[], version: string): void {
  const cwd = mkdtempSync(join(tmpdir(), "solarsql-discovery-"));
  try {
    writeFileSync(join(cwd, "solarsql.config.ts"), 'throw new Error("Discovery imported application configuration");\n');
    const run = (args: string[]) => spawnSync(invocation[0]!, [...invocation.slice(1), ...args], {
      cwd, encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    for (const args of [["--help"], ["-h"], ["help"], ...["analyze", "build", "rehearse", "inspect", "migration", "init"].flatMap(command => [[command, "--help"], [command, "-h"], ["help", command]])]) {
      const result = run(args);
      assert.equal(result.status, 0, `${args}: ${result.stderr}`);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /^usage:\n  solarsql /);
      if (args.length === 2) assert.ok(result.stdout.includes(`solarsql ${args[0] === "help" ? args[1] : args[0]} `));
    }
    for (const flag of ["--version", "-v"]) {
      const result = run([flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, version + "\n");
    }
    for (const args of [["unknown"], ["help", "unknown"], ["--version", "extra"], ["build", "--bad", "--help"]]) {
      const result = run(args);
      assert.equal(result.status, 2, `${args}: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^usage:/);
    }
    assert.deepEqual(readdirSync(cwd), ["solarsql.config.ts"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
