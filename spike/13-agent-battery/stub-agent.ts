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
import { join } from "node:path";

const scenario = process.env.SOLARSQL_BATTERY_SCENARIO;
const skipFix = process.env.SOLARSQL_BATTERY_SKIP_FIX === "1";
const configArg = "example/solarsql.config.ts";
const ordersModule = join("example/modules/orders/module.ts");
const reportsModule = join("example/modules/reports/module.ts");

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

// Runs the same command line the skill or the build's own "next:" line
// names, through a shell -- the same way a real agent's Bash tool would.
function run(command: string): { status: number; output: string } {
  turns++;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  const result = spawnSync(command, { shell: true, cwd: process.cwd(), encoding: "utf8" });
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

const fixes: Record<string, () => void> = {
  "invalid-sql": fixInvalidSql,
  "stale-generated": fixStaleGenerated,
  "ddl-only": fixDdlOnly,
  "cross-module-write": fixCrossModuleWrite,
  "rename-needs-intent": fixRenameNeedsIntent,
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
