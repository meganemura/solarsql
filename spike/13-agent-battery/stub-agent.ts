#!/usr/bin/env node
// Responsibility: a scripted fixer that proves the harness, not a model. It
// runs in the starter's own directory (run.ts sets cwd), applies the known
// fix for the scenario named by SOLARSQL_BATTERY_SCENARIO with the same
// commands an agent would run, and prints one JSON object per line on
// stdout in Claude Code's `--output-format stream-json` shape, so
// metrics.ts's parser needs no stub-specific branch.
// Boundary: the fixes below are only correct for the five scenarios in
// scenarios.ts; a sixth scenario needs a new branch here, not a generalized
// fixer -- generality is not this file's job, proving check() is.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tscArgs } from "../../test/fixture-dir.ts";

const scenario = process.env.SOLARSQL_BATTERY_SCENARIO;
const skipFix = process.env.SOLARSQL_BATTERY_SKIP_FIX === "1";
const configArg = "example/solarsql.config.ts";
const ordersModule = join("example/modules/orders/module.ts");
const reportsModule = join("example/modules/reports/module.ts");
const scaleConfigArg = "scale/solarsql.config.ts";
// CUSTOMER_TABLE/REFERENCING_TABLE, spike/13-agent-battery/cascade-check.ts.
const t10Module = join("scale/t10/module.ts");
const t11Module = join("scale/t11/module.ts");
const flatModule = join("scale/all/module.ts");

// The repository this stub lives in, not the starter's copy -- run() below
// resolves "npx solarsql"/"npx tsc" straight to node + these entry points
// instead of a shell npx lookup, so the stub's own execution never depends
// on shell command resolution (the wall the starter's bin shims exist for).
const root = resolve(import.meta.dirname, "../..");
const cliPath = join(root, "src/build/cli.ts");

// Turns the command text an agent would type into node + a real entry
// point. Only the two forms below appear in this file's fixes.
function commandArgs(command: string): [string, string[]] {
  if (command === "npx tsc --noEmit") return tscArgs(root, ["--noEmit"]);
  if (command.startsWith("npx solarsql ")) return [process.execPath, [cliPath, ...command.slice("npx solarsql ".length).split(" ")]];
  throw new Error(`stub run: unrecognized command ${JSON.stringify(command)}`);
}

// A stub has no real conversation turns; one per tool call it makes is a
// reasonable stand-in, present so metrics.ts's turns field is never null
// for the stub's own runs.
let turns = 0;

function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function read(filePath: string): string {
  turns++;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: join(process.cwd(), filePath) } }] } });
  return readFileSync(filePath, "utf8");
}

function edit(filePath: string, apply: (source: string) => string): void {
  const before = readFileSync(filePath, "utf8");
  const after = apply(before);
  if (after === before) throw new Error(`stub edit did not change ${filePath}`);
  writeFileSync(filePath, after);
  turns++;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(process.cwd(), filePath) } }] } });
}

function write(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  turns++;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: join(process.cwd(), filePath) } }] } });
}

// Reports the same command line the skill or the build's own "next:" line
// names -- the text an agent's Bash tool would show and metrics.ts pins on
// -- but runs it as node + a real entry point (commandArgs above), not
// through a shell, so the stub's result never depends on shell resolution.
function run(command: string): { status: number; output: string } {
  turns++;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  const [cmd, args] = commandArgs(command);
  const result = spawnSync(cmd, args, { cwd: process.cwd(), encoding: "utf8" });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const isError = result.status !== 0;
  emit({ type: "user", message: { content: [{ type: "tool_result", is_error: isError, content: output.slice(0, 2000) }] } });
  return { status: result.status ?? 1, output };
}

function requireReplace(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`stub fix did not match: ${JSON.stringify(from)}`);
  return source.replace(from, to);
}

function replaceAll(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`stub fix did not match: ${JSON.stringify(from)}`);
  return source.split(from).join(to);
}

function fixInvalidSql(): void {
  read(ordersModule);
  const diagnostic = run(`npx solarsql build --check ${configArg}`);
  if (!skipFix) {
    edit(ordersModule, s => requireReplace(s, "select id, customer_id, status, note_text from orders where id = :id", "select id, customer_id, status, note from orders where id = :id"));
    run(`npx solarsql build --check ${configArg}`);
  }
  void diagnostic;
}

function fixStaleGenerated(): void {
  read(ordersModule);
  run("npx tsc --noEmit");
  if (!skipFix) {
    run(`npx solarsql build ${configArg}`);
    run("npx tsc --noEmit");
  }
}

function fixDdlOnly(): void {
  read(ordersModule);
  run(`npx solarsql build ${configArg}`);
  if (!skipFix) {
    run(`npx solarsql migration add_priority ${configArg}`);
    run(`npx solarsql build --check ${configArg}`);
  }
}

function fixCrossModuleWrite(): void {
  read(reportsModule);
  read(ordersModule);
  const diagnostic = run(`npx solarsql build ${configArg}`);
  if (!skipFix) {
    edit(reportsModule, s => {
      s = requireReplace(s, 'import { commands, queries, view } from "../../../src/index.ts";', 'import { queries, view } from "../../../src/index.ts";');
      s = requireReplace(
        s,
        "\n\nexport const reportCommands = commands(generated, {\n  flagDraft: {\n    plan: [\"insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')\"],\n  },\n});",
        "",
      );
      return s;
    });
    edit(ordersModule, s =>
      requireReplace(
        s,
        '  clear: {\n    plan: ["delete from order_lines", "delete from orders", "delete from order_search"],\n  },\n});',
        '  clear: {\n    plan: ["delete from order_lines", "delete from orders", "delete from order_search"],\n  },\n  flagDraft: {\n    plan: ["insert into orders (id, customer_id, status) values (:id, :customer_id, \'draft\')"],\n  },\n});',
      ),
    );
    run(`npx solarsql build --check ${configArg}`);
  }
  void diagnostic;
}

// The declaration-only rename (scenarios.ts's setup) leaves every query,
// trigger, and command that still spells the column "note" pointing at a
// column that no longer exists; a real rename touches every reference, not
// only the declaration, so the fix renames them all before the build can
// even report the pending migration.
function fixRenameNeedsIntent(): void {
  read(ordersModule);
  if (!skipFix) {
    edit(ordersModule, s => {
      s = requireReplace(
        s,
        "insert into order_search (order_id, note) values (new.id, new.note);\n  end\n`);\n\nexport const orderSearchUpdate = trigger(`\n  create trigger order_search_update after update of note on orders\n  begin\n    delete from order_search where order_id = new.id;\n    insert into order_search (order_id, note) values (new.id, new.note);",
        "insert into order_search (order_id, note) values (new.id, new.memo);\n  end\n`);\n\nexport const orderSearchUpdate = trigger(`\n  create trigger order_search_update after update of memo on orders\n  begin\n    delete from order_search where order_id = new.id;\n    insert into order_search (order_id, note) values (new.id, new.memo);",
      );
      s = requireReplace(s, "select id, customer_id, status, note from orders where id = :id`,\n  withLines:", "select id, customer_id, status, memo from orders where id = :id`,\n  withLines:");
      s = requireReplace(s, "select id, status, note from orders\n    where customer_id", "select id, status, memo from orders\n    where customer_id");
      s = requireReplace(s, "select id, status, note from orders where note like :pattern order by id`,", "select id, status, memo from orders where memo like :pattern order by id`,");
      s = requireReplace(s, "select o.id, o.status, o.note, cast(bm25(order_search) as real) as score", "select o.id, o.status, o.memo, cast(bm25(order_search) as real) as score");
      s = replaceAll(s, 'returns: "select id, customer_id, status, note from orders where id = :id",', 'returns: "select id, customer_id, status, memo from orders where id = :id",');
      s = requireReplace(s, 'plan: ["update orders set note = :note where id = :id"],\n    returns: "select id, note, updated_at from orders where id = :id",', 'plan: ["update orders set memo = :note where id = :id"],\n    returns: "select id, memo, updated_at from orders where id = :id",');
      return s;
    });
  }
  const diagnostic = run(`npx solarsql build ${configArg}`);
  if (!skipFix) {
    write(
      "changes.json",
      JSON.stringify({ version: 1, drops: [], renames: [{ table: "orders", from: "note", to: "memo" }] }, null, 2),
    );
    run(`npx solarsql migration rename_note --intent changes.json ${configArg}`);
    run(`npx solarsql build --check ${configArg}`);
  }
  void diagnostic;
}

// The customer table gets a nullable column (a cheap ALTER, schema.md's
// "new column with a default, or nullable"), added the same way in both
// arms. Table names are spike/12-build-scale.ts's own ("t10", not
// "customers") -- cascade-check.ts's CUSTOMER_TABLE/REFERENCING_TABLE name
// the same pair this file hardcodes as t10/t11.
function addDeletedAt(source: string): string {
  return requireReplace(
    source,
    "export const t10 = table(`create table t10 (\n    id text primary key not null,\n    parent_id text references t9(id),\n    a text not null,\n    b text not null,\n    n integer not null,\n    r real not null\n  ) strict`);",
    "export const t10 = table(`create table t10 (\n    id text primary key not null,\n    parent_id text references t9(id),\n    a text not null,\n    b text not null,\n    n integer not null,\n    r real not null,\n    deleted_at text\n  ) strict`);",
  );
}

// A build refuses an on-delete-cascade foreign key here (confirmed against
// this generator: deleting a t10 row would then also delete t11 rows
// through a command t10 does not own -- commands.md, "What a plan may
// touch"), so the owning module's own command is the only legal shape: t11
// gets a new command that deletes its own rows by the customer's id.
// Appended after the generator's own c9, where an author adds a command,
// not inserted first -- cascade-check.ts finds it by what it does (a
// parameter-bound delete from t11, preferring one that names parent_id
// over the generator's own by-id deletes), not by where it sits in the
// catalog.
function addDeleteByParent(source: string): string {
  return requireReplace(
    source,
    '    plan: ["insert into t11 (id, parent_id, a, b, n, r) values (:id9, :parent_id9, :a9, :b9, :n9, :r9)"],\n    returns: "select id, a, b, n, r from t11 where id = :id9",\n  },\n});',
    '    plan: ["insert into t11 (id, parent_id, a, b, n, r) values (:id9, :parent_id9, :a9, :b9, :n9, :r9)"],\n    returns: "select id, a, b, n, r from t11 where id = :id9",\n  },\n  deleteByParent: {\n    plan: ["delete from t11 where parent_id = :parent_id"],\n  },\n});',
  );
}

function shipScaleMigration(config: string): void {
  const diagnostic = run(`npx solarsql build ${config}`);
  if (!skipFix) {
    run(`npx solarsql migration cascade ${config}`);
    run(`npx solarsql build ${config}`);
    run(`npx solarsql build --check ${config}`);
  }
  void diagnostic;
}

function fixOwnedCrossModule(): void {
  read(t10Module);
  read(t11Module);
  if (!skipFix) {
    edit(t10Module, addDeletedAt);
    edit(t11Module, addDeleteByParent);
  }
  shipScaleMigration(scaleConfigArg);
}

function fixFlatCrossModule(): void {
  read(flatModule);
  if (!skipFix) {
    edit(flatModule, s => addDeleteByParent(addDeletedAt(s)));
  }
  shipScaleMigration(scaleConfigArg);
}

const fixes: Record<string, () => void> = {
  "invalid-sql": fixInvalidSql,
  "stale-generated": fixStaleGenerated,
  "ddl-only": fixDdlOnly,
  "cross-module-write": fixCrossModuleWrite,
  "rename-needs-intent": fixRenameNeedsIntent,
  "owned-cross-module": fixOwnedCrossModule,
  "flat-cross-module": fixFlatCrossModule,
};

async function main(): Promise<void> {
  // Drain the task from stdin, the same input contract a real agent CLI
  // reads its prompt from; the stub already knows the fix, so it does not
  // parse the text.
  for await (const _chunk of process.stdin) { /* drained, not read */ }

  const fix = scenario ? fixes[scenario] : undefined;
  if (!fix) {
    emit({ type: "result", subtype: "error", duration_ms: 0, error: `unknown SOLARSQL_BATTERY_SCENARIO: ${scenario}` });
    process.exitCode = 1;
    return;
  }
  const start = Date.now();
  try {
    fix();
    emit({ type: "result", subtype: "success", duration_ms: Date.now() - start, total_cost_usd: 0, num_turns: turns });
  } catch (error) {
    emit({ type: "result", subtype: "error", duration_ms: Date.now() - start, total_cost_usd: 0, num_turns: turns, error: String(error) });
    process.exitCode = 1;
  }
}

await main();
