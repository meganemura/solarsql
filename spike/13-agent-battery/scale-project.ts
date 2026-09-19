// Responsibility: the "scale" project the two cross-module scenarios run
// against -- a 12-module generated project (spike/12-build-scale.ts's
// writeProject, reused, not reimplemented), an "owned" arm (one module per
// table) and a "flat" arm (spike/12's tables concatenated into one module,
// so no module-boundary check applies to a write), plus the cascade check
// both scenarios share.
// Boundary: this file only builds and checks the scale project; scenarios.ts
// owns the task text and setup/check wiring, stub-agent.ts owns the
// scripted fix.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "../../test/fixture-dir.ts";
import { moduleFiles, writeProject } from "../12-build-scale.ts";
import { writeShims, writeSkillAndNotes } from "./starter.ts";
import { build, migration } from "../../src/build/build.ts";
import { CUSTOMER_TABLE, REFERENCING_TABLE, type Arm, type CascadeCheckResult } from "./cascade-check.ts";

export { CUSTOMER_TABLE, REFERENCING_TABLE, type Arm, type CascadeCheckResult };

// N modules of M statements each. M has no default in spike/12 (its own
// `main` tries five [n, m] pairs); 20 is the M spike/12 uses for every N
// past the single-module case, so it is the one "default" a reader of that
// file already recognizes.
export const SCALE_N = 12;
export const SCALE_M = 20;
// CUSTOMER_TABLE and REFERENCING_TABLE (cascade-check.ts) are a pair with an
// actual foreign key between them (t{i}.parent_id references t{i-1}(id), the
// only relationship spike/12's generator gives), so the task's "which
// references it" is true of the generated project instead of asserted by
// the task text alone. The spec's own module numbers (3 and 7) name no such
// relationship in this generator; adapting the pair is the one deviation
// from the spec's literal wording, made under its own "adapt the wording to
// the generator's actual table names" allowance. They live in
// cascade-check.ts, since the check worker needs them in its own process
// without importing this file.

function tableBlock(i: number, m: number, libraryPath: string): string {
  const full = moduleFiles(i, m, libraryPath);
  const marker = 'import { generated } from "./solarsql.generated.ts";\n';
  const at = full.indexOf(marker);
  return full.slice(at + marker.length).trimStart();
}

// Every table's exported names (t3, t3Index, t3Queries, t3Commands, ...) are
// already unique across modules, since spike/12 names them by table index;
// concatenating the tables' own blocks under one shared import needs no
// renaming, only stripping each block's own repeated import lines.
export function writeFlatProject(dir: string, n: number, m: number, libraryPath: string): string {
  const moduleDir = join(dir, "all");
  mkdirSync(moduleDir, { recursive: true });
  const blocks = Array.from({ length: n }, (_, i) => tableBlock(i, m, libraryPath));
  const content = `import { assert, commands, index, queries, table } from ${JSON.stringify(libraryPath)};\nimport { generated } from "./solarsql.generated.ts";\n\n${blocks.join("\n")}`;
  writeFileSync(join(moduleDir, "module.ts"), content);
  const configPath = join(dir, "solarsql.config.ts");
  writeFileSync(configPath, `export default { modules: ["./all"], migrations: "./migrations", library: ${JSON.stringify(libraryPath)} };\n`);
  return configPath;
}

// Builds and writes the first migration, the same "ship the fresh project"
// step a developer runs once after `solarsql init`, so both arms start from
// a passing `build --check` before a scenario's task ever touches them (this
// is the setup-time assertion the spec's Build step 2 asks for).
async function establishBaseline(configPath: string, cliPath: string): Promise<void> {
  await build(configPath);
  const result = await migration(configPath, "init");
  if (result.path === null) throw new Error(`scale project baseline: no migration written (${result.reason})`);
  const checked = spawnSync(process.execPath, [cliPath, "build", "--check", configPath], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(`scale project baseline: build --check still fails:\n${(checked.stdout ?? "") + (checked.stderr ?? "")}`);
}

// A fresh starter for one arm of the cross-module scenarios: the
// repository's own src/ (copied, not referenced, so a battery run touches
// only its own directory and the solarsql shim below has a src/build/cli.ts
// to forward to), the generated "scale" project under scale/, the skill and
// project notes, and the same node_modules/.bin shims the example starter
// uses.
export async function buildScaleStarter(repoRoot: string, arm: Arm): Promise<string> {
  const dir = fixtureDir("battery-scale-");
  cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });

  const scaleDir = join(dir, "scale");
  mkdirSync(scaleDir, { recursive: true });
  // A relative specifier, not the absolute path to this starter's own
  // copied src/ -- an absolute path is unique per starter (a fresh tmp
  // dir), so every module.ts and solarsql.generated.ts would then differ
  // from the pristine starter's own copy in this one line alone, drowning
  // hunksOutsideTask in noise the fix never wrote. Every table's directory
  // sits two levels under `dir` (scale/t3, scale/all), the same depth
  // spike/12-build-scale.ts's own default embeds for this repository.
  const libraryPath = "../../src/index.ts";
  const configPath = arm === "owned"
    ? writeProject(scaleDir, SCALE_N, SCALE_M, libraryPath)
    : writeFlatProject(scaleDir, SCALE_N, SCALE_M, libraryPath);
  await establishBaseline(configPath, join(dir, "src/build/cli.ts"));

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "solarsql-battery-scale", private: true, type: "module", scripts: { test: "node --test" } }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "esnext", module: "nodenext", strict: true, exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true, noEmit: true, allowImportingTsExtensions: true,
        erasableSyntaxOnly: true, verbatimModuleSyntax: true, skipLibCheck: true, types: ["node"],
        typeRoots: [join(repoRoot, "node_modules", "@types")],
      },
      include: ["src", "scale"],
    }),
  );

  writeShims(dir, repoRoot);
  writeSkillAndNotes(
    dir,
    "This project uses solarsql, the typed SQL layer for SQLite on Cloudflare D1 and Durable Objects.\n" +
      "Follow the solarsql skill for its workflow.\n" +
      `The project is under scale/; its configuration is scale/solarsql.config.ts. Module ${CUSTOMER_TABLE.slice(1)} owns ${CUSTOMER_TABLE}, module ${REFERENCING_TABLE.slice(1)} owns ${REFERENCING_TABLE}${arm === "flat" ? " (one module, scale/all/module.ts, owns every table in this project)" : ""}.\n`,
  );

  return dir;
}

const cascadeCheckWorker = join(import.meta.dirname, "cascade-check-worker.ts");

// The check both cross-module scenarios share (cascade-check.ts's
// runCascadeCheck), run in a fresh child process (cascade-check-worker.ts),
// not called in-process: this same process already imported the starter's
// module.ts and solarsql.generated.ts once, while establishBaseline built
// it, and a later in-process import of the same path -- after the
// scenario's fix rewrote those files -- returns that stale, pre-fix module
// from Node's cache instead (confirmed against this project's own generated
// types, which silently reported "no parameters declared" for an
// unmodified, unrelated command). A separate process has no such cache to
// collide with.
export function checkCascadeDelete(dir: string, project: string, arm: Arm): CascadeCheckResult {
  const result = spawnSync(process.execPath, [cascadeCheckWorker, dir, project, arm], { encoding: "utf8" });
  if (result.status !== 0 && !result.stdout) return { ok: false, reason: `cascade check worker: ${(result.stdout ?? "") + (result.stderr ?? "")}` };
  try {
    return JSON.parse(result.stdout) as CascadeCheckResult;
  } catch {
    return { ok: false, reason: `cascade check worker produced no JSON:\n${(result.stdout ?? "") + (result.stderr ?? "")}` };
  }
}
