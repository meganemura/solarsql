#!/usr/bin/env node
// Responsibility: the command line of solarsql.
//   solarsql build [config]             generate types and report migration status
//   solarsql build --check [config]     the same, writing nothing; exit 1 when a file is stale
//   solarsql migration <name> [config]  write the next migration file
//   solarsql init <module> [dir]        a first module, built, with its migration
// Boundary: printing and exit codes only. build.ts and init.ts do the work.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeSchema } from "./analyze.ts";
import { rehearse } from "./rehearse.ts";
import { build, migration } from "./build.ts";
import { init } from "./init.ts";
import { isReportWorker, printReport, runMachine, runRehearsalProcess } from "./machine.ts";
import { shellArgument } from "./shell.ts";
import { BuildError } from "./typegen.ts";

const usage = `usage:
  solarsql analyze <schema.sql> <queries.json> [--out generated.ts] [--check] [--library specifier]
  solarsql build [solarsql.config.ts]
  solarsql build --check [solarsql.config.ts]   writes nothing; exit 1 when a generated file or a migration is stale
  solarsql rehearse <database.sqlite> <change.sql> [checks.json] [--timeout-ms 30000]   validate a disposable snapshot
  solarsql inspect [solarsql.config.ts]        JSON contracts, accesses and freshness; writes no build artifacts
  solarsql build --json [solarsql.config.ts]   machine-readable generation result (combine with --check)
  solarsql migration <name> [solarsql.config.ts]
  solarsql init <module> [dir]                  writes solarsql.config.ts and modules/<module>/, then builds and writes the first migration`;

// One line of SQL, enough to recognize the statement.
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 100);
}

function rehearsalArguments(args: string[]): { paths: string[]; timeoutMs: number } {
  const paths: string[] = [];
  let timeoutMs = 30_000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--timeout-ms") {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
        throw new BuildError("--timeout-ms requires an integer from 1 to 2147483647 milliseconds.");
      }
      timeoutMs = Number(value);
    } else if (arg.startsWith("--")) throw new BuildError(`Unknown rehearse option ${arg}.`);
    else paths.push(arg);
  }
  if (paths.length < 2 || paths.length > 3) throw new BuildError("Use solarsql rehearse <database.sqlite> <change.sql> [checks.json] [--timeout-ms 30000].");
  return { paths, timeoutMs };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "analyze") {
    const paths: string[] = [];
    let out: string | undefined;
    let library = "solarsql";
    let check = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--check") check = true;
      else if (arg === "--out" || arg === "--library") {
        const value = rest[++i];
        if (!value || value.startsWith("--")) throw new BuildError(`${arg} requires a value.`);
        if (arg === "--out") out = value; else library = value;
      } else if (arg.startsWith("--")) throw new BuildError(`Unknown analyze option ${arg}.`);
      else paths.push(arg);
    }
    if (paths.length !== 2 || (check && !out)) throw new BuildError("Use solarsql analyze <schema.sql> <queries.json> [--out generated.ts] [--check]. --check requires --out.");
    if (out && paths.some(path => resolve(path) === resolve(out))) throw new BuildError("The output must differ from the schema and catalog paths.");
    if (out && existsSync(out)) {
      const target = statSync(out);
      if (paths.some(path => { const input = statSync(path); return input.dev === target.dev && input.ino === target.ino; })) {
        throw new BuildError("The output must not link to the schema or catalog file.");
      }
    }
    const result = analyzeSchema(readFileSync(paths[0]!, "utf8"), JSON.parse(readFileSync(paths[1]!, "utf8")), library);
    const changed = out !== undefined && (!existsSync(out) || readFileSync(out, "utf8") !== result.generated);
    if (out && !check && changed) writeFileSync(out, result.generated);
    const ok = !(check && changed);
    await printReport({ ...result, generated: out ? undefined : result.generated, ok, output: out, changed,
      diagnostics: ok ? [] : [{ code: "GENERATED_STALE", action: "Repeat analyze with the same inputs and --out, without --check." }] });
    return ok ? 0 : 1;
  }
  if (command === "rehearse") {
    const { paths } = rehearsalArguments(rest);
    const checks = paths[2] ? JSON.parse(readFileSync(paths[2], "utf8")) : {};
    const report = await rehearse(paths[0]!, readFileSync(paths[1]!, "utf8"), checks);
    await printReport(report);
    return report.ok ? 0 : 1;
  }
  if (command === "build" || command === "inspect") {
    const inspect = command === "inspect";
    const check = inspect || rest.includes("--check");
    const json = inspect || rest.includes("--json");
    const args = rest.filter((a) => a !== "--check" && a !== "--json");
    if (args.length > 1 || args.some(a => a.startsWith("--"))) throw new BuildError("Unexpected build argument. Use solarsql inspect [config] or solarsql build [--check] [--json] [config].");
    const configArgument = args[0] === undefined ? "" : ` ${shellArgument(args[0])}`;
    const result = await build(args[0] ?? "solarsql.config.ts", { write: !check, inspect });
    if (json) {
      const diagnostics = [
        ...(check && (result.modules.some(m => m.changed) || result.index.changed) ? [{ code: "GENERATED_STALE", action: `npx solarsql build${configArgument}` }] : []),
        ...(result.migration.pending ? [{ code: result.migration.reason ? "MIGRATION_BLOCKED" : "MIGRATION_PENDING", message: result.migration.reason,
          action: result.migration.reason ? "Write a manual migration and run build." : `npx solarsql migration <name>${configArgument}` }] : []),
      ];
      const ok = !check || diagnostics.length === 0;
      await printReport({ version: 1, ok, mode: inspect ? "inspect" : check ? "check" : "build", diagnostics,
        contract: { types: "engine-metadata-and-static-inference", execution: "local-node-sqlite", imports: "application-modules-execute", deploymentVerified: false }, result });
      return ok ? 0 : 1;
    }
    for (const m of result.modules) {
      console.log(`${m.changed ? (check ? "stale  " : "wrote  ") : "current"} ${m.generatedPath} (${m.entries} statements, ${m.ms}ms)`);
      for (const k of m.added) console.log(`  + ${oneLine(k)}`);
      for (const k of m.removed) console.log(`  - ${oneLine(k)}`);
    }
    for (const s of result.scans) {
      console.log(`scan    ${s.module}: ${s.tables.join(", ")} read in full by: ${oneLine(s.sql)}`);
    }
    for (const r of result.reads) {
      console.log(`reads   ${r.module}.${r.query}: ${r.tables.length > 0 ? r.tables.join(", ") : "(none)"}`);
    }
    console.log(`time    ${result.ms}ms`);
    if (result.index.path !== null && result.index.changed) console.log(`${check ? "stale  " : "wrote  "} ${result.index.path} (the migration files, for a Durable Object)`);
    if (result.migration.reason) {
      console.error(`migration blocked: ${result.migration.reason}`);
      console.error(`Write a manual SQL migration in the configured migrations directory, then run: npx solarsql build${configArgument}`);
      return check ? 1 : 0;
    }
    if (result.migration.pending) {
      console.error(`migration pending. Write the migration: npx solarsql migration <name>${configArgument}`);
      for (const s of result.migration.statements) console.error(`  ${s.replace(/\s+/g, " ").trim()}`);
      return check ? 1 : 0;
    }
    if (check && (result.modules.some((m) => m.changed) || result.index.changed)) {
      console.error(`generated files are stale. Run: npx solarsql build${configArgument}`);
      return 1;
    }
    console.log("migrations are current");
    return 0;
  }
  if (command === "migration") {
    const name = rest[0];
    if (!name) {
      console.error(usage);
      return 2;
    }
    const result = await migration(rest[1] ?? "solarsql.config.ts", name);
    if (result.reason) {
      console.error(`migration blocked: ${result.reason}`);
      return 1;
    }
    console.log(result.filename ? `wrote ${result.filename}` : "nothing to migrate");
    return 0;
  }
  if (command === "init") {
    const module = rest[0];
    if (!module) {
      console.error(usage);
      return 2;
    }
    const result = await init(module, rest[1] ?? ".");
    for (const f of result.written) console.log(`wrote   ${f}`);
    if (result.notice) console.log(`note    ${result.notice}`);
    console.log(`next    node --test                 runs modules/${module}/module.test.ts on node:sqlite`);
    console.log(`        npx tsc --noEmit            typescript and @types/node are the dev dependencies it needs`);
    console.log(`        import { d1 } from "solarsql/d1", or "solarsql/durable", in the Worker; see the README`);
    console.log(`        point AGENTS.md at node_modules/solarsql/skills/solarsql/SKILL.md, the usage documentation for an agent`);
    return 0;
  }
  console.error(usage);
  return 2;
}

const args = process.argv.slice(2);
const machineBuild = args[0] === "inspect" || (args[0] === "build" && args.includes("--json"));
try {
  const code = args[0] === "rehearse" && !isReportWorker()
    ? await runRehearsalProcess(import.meta.filename, args, rehearsalArguments(args.slice(1)).timeoutMs)
    : machineBuild && !isReportWorker()
    ? await runMachine(import.meta.filename, args)
    : await main(args);
  process.exit(code);
} catch (e) {
  if (args.includes("--json") || ["inspect", "rehearse", "analyze"].includes(args[0] ?? "")) {
    await printReport({ version: 1, ok: false, diagnostics: [{ code: "BUILD_FAILED", message: e instanceof Error ? e.message : String(e), sql: e instanceof BuildError ? e.sql : undefined, locations: e instanceof BuildError ? e.locations : [] }] });
  } else if (e instanceof BuildError) console.error(`error: ${e.message}`);
  else console.error(e);
  process.exit(1);
}
