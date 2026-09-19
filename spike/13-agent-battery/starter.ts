// Responsibility: a fresh starter project for one battery run -- a copy of
// src/ and example/ (so a run cannot touch the repository), with the skill
// where a Claude Code agent finds it and node_modules/.bin shims (a .cmd
// pair alongside each extensionless one) so `npx solarsql ...` and
// `npx tsc ...`, the commands the skill and the build's own "next:" line
// name, resolve without a network install on every platform.
// Boundary: this file only builds the starter; scenarios.ts breaks it and
// checks it, stub-agent.ts (or a real agent) repairs it.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyExample } from "../../test/copy-example.ts";
import { fixtureDir } from "../../test/fixture-dir.ts";

const skillSource = join(import.meta.dirname, "../../skills/solarsql");

// Forwards to the repository's own TypeScript entry point (src/build/cli.ts
// runs directly under Node's type-stripping, as every CLI test in this
// repository already relies on) so the starter needs no npm install.
const solarsqlShim = () => [
  "#!/usr/bin/env node",
  'const { spawnSync } = require("node:child_process");',
  'const { join } = require("node:path");',
  `const cli = join(__dirname, "../../src/build/cli.ts");`,
  "const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: \"inherit\" });",
  "process.exit(result.status ?? 1);",
  "",
].join("\n");

// tsc auto-discovers ./tsconfig.json (copyExample writes one at the starter
// root) from the caller's cwd, so this shim needs no -p flag of its own.
const tscShim = (repoRoot: string) => [
  "#!/usr/bin/env node",
  'const { spawnSync } = require("node:child_process");',
  `const tsc = ${JSON.stringify(join(repoRoot, "node_modules/typescript/bin/tsc"))};`,
  "const result = spawnSync(process.execPath, [tsc, ...process.argv.slice(2)], { stdio: \"inherit\" });",
  "process.exit(result.status ?? 1);",
  "",
].join("\n");

// npx resolves a bin name to node_modules/.bin/<name>.cmd on Windows and to
// the extensionless script everywhere else; the extensionless script has no
// shebang cmd.exe understands, so npx would fail on Windows without this
// wrapper. POSIX shells never see the .cmd file.
const cmdShim = (name: string) => [`@node "%~dp0${name}" %*`, ""].join("\r\n");

// The two shims every starter needs, shared by the example starter below and
// spike/13-agent-battery/scale-project.ts's scale starter, so `npx solarsql`
// and `npx tsc` resolve the same way in both.
export function writeShims(dir: string, repoRoot: string): void {
  const binDir = join(dir, "node_modules/.bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "solarsql"), solarsqlShim());
  chmodSync(join(binDir, "solarsql"), 0o755);
  writeFileSync(join(binDir, "solarsql.cmd"), cmdShim("solarsql"));
  writeFileSync(join(binDir, "tsc"), tscShim(repoRoot));
  chmodSync(join(binDir, "tsc"), 0o755);
  writeFileSync(join(binDir, "tsc.cmd"), cmdShim("tsc"));
}

// The skill, plus the same project note under both names Claude Code and a
// plain AGENTS.md reader look for -- shared by the example and scale
// starters; `projectNote` is the one sentence that differs between them.
export function writeSkillAndNotes(dir: string, projectNote: string): void {
  const skillDir = join(dir, ".claude/skills/solarsql");
  mkdirSync(skillDir, { recursive: true });
  cpSync(skillSource, skillDir, { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), projectNote);
  writeFileSync(join(dir, "CLAUDE.md"), projectNote);
}

// A smoke test, so `npm test` -- the command the build's own "next:" line
// names after a migration -- reports one pass instead of node:test's
// file-not-found error on an empty test/. Shared by the example and scale
// starters (finalizeStarter below), so neither writes it twice.
function writeSmokeTest(dir: string): void {
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test/smoke.test.ts"), 'import { test } from "node:test";\n\ntest("starter", () => {});\n');
}

// Run after a scenario's setup has broken (or, for the two cross-module
// scenarios, left untouched) the starter, and before the agent starts: the
// smoke test above, then the starter's own git repository, with the setup's
// mutation as the one committed baseline. Measured on three saved
// ddl-only streams (2026-09-19): of 15-18 tool calls per run, 5-6 were an
// agent's `git status`/`git diff`/`git log`/`git rev-parse --show-toplevel`/
// `git check-ignore` resolving past the starter to this repository, since
// the starter sits under this repository's own .scratch/ with no git
// identity of its own; 2-3 more were a search for tests after `npm test`
// found none. A starter that is already a git repository, and already has
// one passing test, answers both before the agent asks.
//
// hunksOutsideTask's own diff (run.ts's diffAgainstPristine) is unaffected:
// it runs `git diff --no-index` on the project subdirectory only (example/
// or scale/), never the starter root where this .git lives.
export function finalizeStarter(dir: string): void {
  writeSmokeTest(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.name=battery", "-c", "user.email=battery@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "starter"], { cwd: dir });
}

export function buildStarter(repoRoot: string): string {
  const dir = fixtureDir("battery-");
  copyExample(dir);
  // example/.dev.vars and .wrangler/ carry one account's token and cache; a
  // paid agent reads its cwd, so the starter drops them.
  rmSync(join(dir, "example/.dev.vars"), { force: true });
  rmSync(join(dir, "example/.wrangler"), { recursive: true, force: true });

  writeShims(dir, repoRoot);

  // Claude Code reads CLAUDE.md, not AGENTS.md; the starter carries both, so
  // an agent that reads either one finds the same three sentences.
  writeSkillAndNotes(
    dir,
    "This project uses solarsql, the typed SQL layer for SQLite on Cloudflare D1 and Durable Objects.\n" +
      "Follow the solarsql skill for its workflow.\n" +
      "The example project is under example/; its configuration is example/solarsql.config.ts.\n",
  );

  return dir;
}
