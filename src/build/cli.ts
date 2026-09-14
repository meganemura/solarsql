#!/usr/bin/env node
// Responsibility: the command line of solarsql.
//   solarsql build [config]             generate types and report migration status
//   solarsql build --check [config]     the same, writing nothing; exit 1 when a file is stale
//   solarsql migration <name> [--intent file] [config]  write the next migration file
//   solarsql init <module> [dir]        a first module, built, with its migration
// Boundary: printing and exit codes only. build.ts and init.ts do the work.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { analyzeDatabase, analyzeSchema } from "./analyze.ts";
import { rehearse } from "./rehearse.ts";
import { build, migration } from "./build.ts";
import { init } from "./init.ts";
import { readMigrationIntent, type MigrationIntent } from "./migration-intent.ts";
import type { DropIntent, Rename, RenameRepair } from "./migration.ts";
import { announceWorkerDone, isCliWorker, isReportWorker, printReport, runHuman, runMachine, runRehearsalProcess } from "./machine.ts";
import { protectInputs, writeGeneratedFile } from "./output.ts";
import { shellArgument } from "./shell.ts";
import { BuildError } from "./typegen.ts";

const usage = `usage:
  solarsql --help                             show commands without loading a project
  solarsql --version                          show the installed package version
  solarsql help [command]                     show all commands or one command
  solarsql analyze --database <database.sqlite> <queries.json> [--out generated.ts] [--check] [--library specifier]
  solarsql analyze <schema.sql> <queries.json> [--out generated.ts] [--check] [--library specifier]
  solarsql build [--timeout-ms 30000] [solarsql.config.ts]
  solarsql build --check [--timeout-ms 30000] [solarsql.config.ts]   writes nothing; exit 1 when a generated file or a migration is stale
  solarsql rehearse <database.sqlite> <change.sql> [checks.json] [--timeout-ms 30000]   validate a disposable snapshot
  solarsql inspect [--timeout-ms 30000] [solarsql.config.ts]        JSON contracts, accesses and freshness; writes no build artifacts
  solarsql build --json [--timeout-ms 30000] [solarsql.config.ts]   machine-readable generation result (combine with --check)
  solarsql migration <name> [--intent changes.json] [--timeout-ms 30000] [solarsql.config.ts]
  solarsql init <module> [dir]                  writes solarsql.config.ts and modules/<module>/, then builds and writes the first migration`;

function discovery(argv: string[]): number | undefined {
  const commands = ["analyze", "build", "rehearse", "inspect", "migration", "init"];
  const [command, ...rest] = argv;
  const help = command === "help" || argv.some(arg => arg === "--help" || arg === "-h");
  const version = command === "--version" || command === "-v";
  if (!help && !version) return undefined;
  if (version && rest.length === 0) {
    const metadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    console.log(metadata.version);
    return 0;
  }
  const all = argv.length === 1 && ["help", "--help", "-h"].includes(command!);
  const selected = argv.length === 2 && command === "help" ? rest[0]
    : argv.length === 2 && ["--help", "-h"].includes(rest[0]!) ? command : undefined;
  if (all || (selected && commands.includes(selected))) {
    console.log(all ? usage : `usage:\n${usage.split("\n").filter(line => line.startsWith(`  solarsql ${selected} `)).join("\n")}`);
    return 0;
  }
  console.error(usage);
  return 2;
}

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

// Parse the deadline in the parent so an invalid budget cannot load project code.
function deadlineArguments(args: string[]): { args: string[]; timeoutMs: number } {
  const workerArgs: string[] = [];
  let timeoutMs = 30_000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--timeout-ms") {
      workerArgs.push(arg);
      continue;
    }
    const value = args[++i];
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
      throw new BuildError("--timeout-ms requires an integer from 1 to 2147483647 milliseconds.");
    }
    timeoutMs = Number(value);
  }
  return { args: workerArgs, timeoutMs };
}

function buildArguments(args: string[]): { configPath: string; check: boolean; json: boolean } {
  let check = false;
  let json = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === "--check") check = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--")) throw new BuildError("Unexpected build argument. Use solarsql build [--check] [--json] [config].");
    else paths.push(arg);
  }
  if (paths.length > 1) throw new BuildError("Unexpected build argument. Use solarsql build [--check] [--json] [config].");
  return { configPath: paths[0] ?? "solarsql.config.ts", check, json };
}

function migrationArguments(args: string[]): { name: string; configPath: string; intent: MigrationIntent } {
  const paths: string[] = [];
  let intentPath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--intent") {
      const value = args[++index];
      if (!value || value.startsWith("--") || intentPath !== undefined) throw new BuildError("--intent requires one JSON file.");
      intentPath = value;
    } else if (arg.startsWith("--")) {
      throw new BuildError(`Unknown migration option ${arg}.`);
    } else {
      paths.push(arg);
    }
  }
  if (paths.length < 1 || paths.length > 2) throw new BuildError("Use solarsql migration <name> [--intent changes.json] [solarsql.config.ts].");
  return { name: paths[0]!, configPath: paths[1] ?? "solarsql.config.ts", intent: intentPath ? readMigrationIntent(intentPath) : { drops: [], renames: [] } };
}

function intentAction(drops: readonly DropIntent[], renames: readonly Rename[], configArgument: string): string {
  const intent = JSON.stringify({ version: 1, drops, renames }, null, 2);
  return `Create changes.json:\n${intent}\nRun: npx solarsql migration describe_change --intent changes.json${configArgument}`;
}

function migrationAction(drops: DropIntent[] | undefined, renames: Rename[] | undefined, renameCandidates: RenameRepair[] | undefined, configArgument: string): string {
  if (drops || renames) return intentAction(drops ?? [], renames ?? [], configArgument);
  if (renameCandidates) return `Choose a one-to-one rename map from:\n${JSON.stringify(renameCandidates, null, 2)}\nRun: npx solarsql migration describe_change --intent changes.json${configArgument}`;
  return "Write a manual migration and run build.";
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "analyze") {
    const paths: string[] = [];
    let out: string | undefined;
    let library = "solarsql";
    let check = false;
    let database = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--check") check = true;
      else if (arg === "--database") database = true;
      else if (arg === "--out" || arg === "--library") {
        const value = rest[++i];
        if (!value || value.startsWith("--")) throw new BuildError(`${arg} requires a value.`);
        if (arg === "--out") out = value; else library = value;
      } else if (arg.startsWith("--")) throw new BuildError(`Unknown analyze option ${arg}.`);
      else paths.push(arg);
    }
    if (paths.length !== 2 || (check && !out)) throw new BuildError("Use solarsql analyze [--database] <schema.sql or database.sqlite> <queries.json> [--out generated.ts] [--check]. --check requires --out.");
    const inputs = [...paths];
    if (database) {
      const source = realpathSync(paths[0]!);
      inputs.push(source, ...[paths[0]!, source].flatMap(path => [path + "-wal", path + "-shm", path + "-journal"]));
    }
    if (out) protectInputs(out, inputs);
    const catalog = JSON.parse(readFileSync(paths[1]!, "utf8"));
    const result = database ? analyzeDatabase(paths[0]!, catalog, library) : analyzeSchema(readFileSync(paths[0]!, "utf8"), catalog, library);
    const changed = out !== undefined && (!existsSync(out) || readFileSync(out, "utf8") !== result.generated);
    if (out && !check && changed) writeGeneratedFile(out, result.generated);
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
    const parsed = buildArguments(rest);
    const check = inspect || parsed.check;
    const json = inspect || parsed.json;
    const configArgument = parsed.configPath === "solarsql.config.ts" ? "" : ` ${shellArgument(parsed.configPath)}`;
    const result = await build(parsed.configPath, { write: !check, inspect });
    if (json) {
      const diagnostics = [
        ...(check && (result.modules.some(m => m.changed) || result.index.changed) ? [{ code: "GENERATED_STALE", action: `npx solarsql build${configArgument}` }] : []),
        ...(result.migration.pending ? [{ code: result.migration.reason ? "MIGRATION_BLOCKED" : "MIGRATION_PENDING", message: result.migration.reason,
          action: result.migration.reason ? migrationAction(result.migration.drops, result.migration.renames, result.migration.renameCandidates, configArgument) : `npx solarsql migration <name>${configArgument}` }] : []),
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
      const action = migrationAction(result.migration.drops, result.migration.renames, result.migration.renameCandidates, configArgument);
      console.error(action === "Write a manual migration and run build." ? `Write a manual SQL migration in the configured migrations directory, then run: npx solarsql build${configArgument}` : action);
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
    const { name, configPath, intent } = migrationArguments(rest);
    const result = await migration(configPath, name, intent);
    if (result.reason) {
      console.error(`migration blocked: ${result.reason}`);
      const action = migrationAction(result.drops, result.renames, result.renameCandidates, ` ${shellArgument(configPath)}`);
      if (action !== "Write a manual migration and run build.") console.error(action);
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
const humanBuild = args[0] === "build" || args[0] === "migration";
try {
  // Discovery must precede worker dispatch and application configuration imports.
  const code = discovery(args) ?? (args[0] === "rehearse" && !isReportWorker()
    ? await runRehearsalProcess(import.meta.filename, args, rehearsalArguments(args.slice(1)).timeoutMs)
    : machineBuild && !isReportWorker()
    ? await (() => {
      const machine = deadlineArguments(args);
      // Validate all build arguments before the report worker imports a project.
      buildArguments(machine.args.slice(1));
      return runMachine(import.meta.filename, machine.args, { timeoutMs: machine.timeoutMs, timeoutCode: "BUILD_TIMEOUT",
        action: "Inspect the configuration import and build work. Set --timeout-ms to a larger positive budget if the work requires more time." });
    })()
    : humanBuild && !isReportWorker() && !isCliWorker()
    ? await (() => {
      const worker = deadlineArguments(args);
      if (worker.args[0] === "build") buildArguments(worker.args.slice(1));
      else migrationArguments(worker.args.slice(1));
      return runHuman(import.meta.filename, worker.args, worker.timeoutMs);
    })()
    : await main(args));
  if (isCliWorker()) await announceWorkerDone(code);
  process.exit(code);
} catch (e) {
  if (args.includes("--json") || ["inspect", "rehearse", "analyze"].includes(args[0] ?? "")) {
    await printReport({ version: 1, ok: false, diagnostics: [{ code: "BUILD_FAILED", message: e instanceof Error ? e.message : String(e), sql: e instanceof BuildError ? e.sql : undefined, locations: e instanceof BuildError ? e.locations : [] }] });
  } else if (e instanceof BuildError) console.error(`error: ${e.message}`);
  else console.error(e);
  if (isCliWorker()) await announceWorkerDone(1);
  process.exit(1);
}
