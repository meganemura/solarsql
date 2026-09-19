// Responsibility: the five scenarios the battery runs -- each breaks one
// file of a fresh starter, states the task in the words a human would give
// an agent, and checks the repaired project against the library's own
// rules (a passing build, tsc, and the migration shape the task asked for).
// Boundary: this file edits and reads files; it does not spawn an agent or
// parse an event stream (run.ts and metrics.ts do that) and does not decide
// what a fix looks like (stub-agent.ts does, for the stub).
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tscArgs } from "../../test/fixture-dir.ts";
import { CUSTOMER_TABLE, REFERENCING_TABLE, SCALE_N, checkCascadeDelete, type Arm } from "./scale-project.ts";

const scaleKnownTables = Array.from({ length: SCALE_N }, (_, i) => `t${i}`);

const root = resolve(import.meta.dirname, "../..");
export const configArg = "example/solarsql.config.ts";
const ordersModule = "example/modules/orders/module.ts";
const reportsModule = "example/modules/reports/module.ts";
export const scaleConfigArg = "scale/solarsql.config.ts";

export type CheckResult = { ok: boolean; reason?: string };
export type Scenario = {
  name: string;
  // "scale" scenarios build their starter through scale-project.ts's
  // buildScaleStarter (run.ts branches on this), not the example copy.
  project: "example" | "scale";
  // Present only for a "scale" scenario -- which module layout its starter
  // builds (buildScaleStarter's own Arm).
  arm?: Arm;
  // The tables the task concerns, for hunksOutsideTask (metrics.ts): a diff
  // hunk that names a table outside this set is a harmful edit.
  taskTables: readonly string[];
  // Every table (and view, search table) the project could name in a diff
  // hunk -- metrics.ts only counts a hunk outside the task when it matches
  // one of these, so unrelated prose (a migration comment's own boilerplate)
  // can never look like a harmful edit.
  knownTables: readonly string[];
  setup(dir: string): void;
  task: string;
  check(dir: string): Promise<CheckResult>;
};

// A string replacement that fails loudly instead of writing a file whose
// "fix" never happened, the same contract test/copy-example.ts and
// test/stale.test.ts already rely on.
function replace(file: string, from: string, to: string): void {
  const source = readFileSync(file, "utf8");
  if (!source.includes(from)) throw new Error(`replacement did not match in ${file}: ${JSON.stringify(from)}`);
  writeFileSync(file, source.replace(from, to));
}

function buildCheck(dir: string, config: string = configArg): { ok: boolean; output: string } {
  const result = spawnSync(process.execPath, [join(dir, "src/build/cli.ts"), "build", "--check", config], { cwd: dir, encoding: "utf8" });
  return { ok: result.status === 0, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

function tscCheck(dir: string): { ok: boolean; output: string } {
  const [cmd, args] = tscArgs(root, ["-p", join(dir, "tsconfig.json")]);
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: result.status === 0, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

// Every scenario's check ends the same way: the generated files and
// migrations match the source, and tsc has no stale-type call site.
function commonChecks(dir: string, config: string = configArg): CheckResult | undefined {
  const build = buildCheck(dir, config);
  if (!build.ok) return { ok: false, reason: `build --check failed:\n${build.output}` };
  const tsc = tscCheck(dir);
  if (!tsc.ok) return { ok: false, reason: `tsc --noEmit failed:\n${tsc.output}` };
  return undefined;
}

function migrationDir(dir: string, project: string = "example"): string {
  return join(dir, project, "migrations");
}

// Any migration file (not index.ts) whose text matches the pattern, and
// whether migrations/index.ts names it -- true once the build regenerates
// it, since every build keeps index.ts in step with the .sql files.
function migrationMatches(dir: string, pattern: RegExp, project: string = "example"): CheckResult {
  const dirPath = migrationDir(dir, project);
  const files = readdirSync(dirPath).filter(f => f.endsWith(".sql"));
  const match = files.find(f => pattern.test(readFileSync(join(dirPath, f), "utf8")));
  if (!match) return { ok: false, reason: `no migration file matches ${pattern} among ${files.join(", ")}` };
  const index = readFileSync(join(dirPath, "index.ts"), "utf8");
  if (!index.includes(match)) return { ok: false, reason: `migrations/index.ts does not list ${match}` };
  return { ok: true };
}

// The example's own orders command count, read from the repository (not
// the starter): the baseline "one more command than before" compares to.
let baselineOrderCommandCount: number | undefined;
async function orderCommandCount(dir: string): Promise<number> {
  const mod = (await import(pathToFileURL(join(dir, ordersModule)).href)) as { orderCommands: Record<string, unknown> };
  return Object.keys(mod.orderCommands).length;
}
async function baselineCount(): Promise<number> {
  if (baselineOrderCommandCount === undefined) baselineOrderCommandCount = await orderCommandCount(root);
  return baselineOrderCommandCount;
}

export const scenarios: Scenario[] = [
  {
    name: "invalid-sql",
    project: "example",
    taskTables: ["orders"],
    knownTables: ["orders", "customers", "order_lines", "order_search", "confirmed_orders", "solarsql_assert"],
    setup(dir) {
      replace(join(dir, ordersModule), "select id, customer_id, status, note from orders where id = :id", "select id, customer_id, status, note_text from orders where id = :id");
    },
    task: "`npx solarsql build --check example/solarsql.config.ts` fails. Fix the project so it passes.",
    async check(dir) {
      const common = commonChecks(dir);
      if (common) return common;
      const source = readFileSync(join(dir, ordersModule), "utf8");
      if (!source.includes("select id, customer_id, status, note from orders where id = :id")) {
        return { ok: false, reason: "orderQueries.byId no longer selects note" };
      }
      return { ok: true };
    },
  },
  {
    name: "stale-generated",
    project: "example",
    taskTables: ["orders"],
    knownTables: ["orders", "customers", "order_lines", "order_search", "confirmed_orders", "solarsql_assert"],
    setup(dir) {
      replace(join(dir, ordersModule), "select id, customer_id, status, note from orders where id = :id", "select id, customer_id, status, note, updated_at from orders where id = :id");
    },
    task: "`npx tsc --noEmit` fails. Make it pass.",
    async check(dir) {
      const tsc = tscCheck(dir);
      if (!tsc.ok) return { ok: false, reason: `tsc --noEmit failed:\n${tsc.output}` };
      const build = buildCheck(dir);
      if (!build.ok) return { ok: false, reason: `build --check failed:\n${build.output}` };
      return { ok: true };
    },
  },
  {
    name: "ddl-only",
    project: "example",
    taskTables: ["orders"],
    knownTables: ["orders", "customers", "order_lines", "order_search", "confirmed_orders", "solarsql_assert"],
    setup(dir) {
      replace(join(dir, ordersModule), "    note text,\n    updated_at text\n  ) strict", "    note text,\n    updated_at text,\n    priority integer not null default 0\n  ) strict");
    },
    task: "I added `priority integer not null default 0` to the orders table in example/modules/orders/module.ts. Ship the change.",
    async check(dir) {
      const common = commonChecks(dir);
      if (common) return common;
      return migrationMatches(dir, /add column\s+"?priority"?\s+integer\s+not\s+null\s+default\s+0/i);
    },
  },
  {
    name: "cross-module-write",
    project: "example",
    taskTables: ["orders"],
    knownTables: ["orders", "customers", "order_lines", "order_search", "confirmed_orders", "solarsql_assert"],
    setup(dir) {
      replace(join(dir, reportsModule), 'import { queries, view } from "../../../src/index.ts";', 'import { commands, queries, view } from "../../../src/index.ts";');
      replace(
        join(dir, reportsModule),
        "    select id, customer_id, customer_name from confirmed_orders order by id`,\n});",
        "    select id, customer_id, customer_name from confirmed_orders order by id`,\n});\n\nexport const reportCommands = commands(generated, {\n  flagDraft: {\n    plan: [\"insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')\"],\n  },\n});",
      );
    },
    task: "I added a command to example/modules/reports/module.ts that inserts an order. The build fails. Make it pass.",
    async check(dir) {
      const common = commonChecks(dir);
      if (common) return common;
      const reports = readFileSync(join(dir, reportsModule), "utf8");
      if (/insert into orders/i.test(reports)) return { ok: false, reason: "reports/module.ts still inserts into orders" };
      const before = await baselineCount();
      const after = await orderCommandCount(dir);
      if (after !== before + 1) return { ok: false, reason: `orders exports ${after} commands, expected ${before + 1}` };
      return { ok: true };
    },
  },
  {
    name: "rename-needs-intent",
    project: "example",
    taskTables: ["orders"],
    knownTables: ["orders", "customers", "order_lines", "order_search", "confirmed_orders", "solarsql_assert"],
    setup(dir) {
      replace(join(dir, ordersModule), "    note text,\n    updated_at text", "    memo text,\n    updated_at text");
    },
    task: "I renamed the note column of orders to memo in example/modules/orders/module.ts. Produce the migration.",
    async check(dir) {
      const common = commonChecks(dir);
      if (common) return common;
      return migrationMatches(dir, /rename column\s+"?note"?\s+to\s+"?memo"?/i);
    },
  },
  // The two module-ownership scenarios (README, "The two arms"): the same
  // task on the same 12-module generated project, once with one module per
  // table (owned) and once with every table in one module (flat, no
  // module-boundary check applies). Each is a no-op setup -- the task is a
  // feature to add, not a break to repair -- so the diff against the
  // pristine starter is exactly what the agent (or the stub) wrote.
  {
    name: "owned-cross-module",
    project: "scale",
    arm: "owned",
    taskTables: [CUSTOMER_TABLE, REFERENCING_TABLE],
    knownTables: scaleKnownTables,
    setup() {},
    task:
      `Customers are rows of ${CUSTOMER_TABLE} (module ${CUSTOMER_TABLE.slice(1)}). Give ${CUSTOMER_TABLE} a nullable ` +
      `\`deleted_at text\` column. When a customer (a ${CUSTOMER_TABLE} row) is deleted, its rows in ${REFERENCING_TABLE} ` +
      `(module ${REFERENCING_TABLE.slice(1)}, which references ${CUSTOMER_TABLE} through its parent_id column) must ` +
      `also be removed. Ship the change with a migration.`,
    async check(dir) {
      const common = commonChecks(dir, scaleConfigArg);
      if (common) return common;
      const migration = migrationMatches(dir, /add column\s+"?deleted_at"?\s+text/i, "scale");
      if (!migration.ok) return migration;
      return checkCascadeDelete(dir, "scale", "owned");
    },
  },
  {
    name: "flat-cross-module",
    project: "scale",
    arm: "flat",
    taskTables: [CUSTOMER_TABLE, REFERENCING_TABLE],
    knownTables: scaleKnownTables,
    setup() {},
    task:
      `Customers are rows of ${CUSTOMER_TABLE}. Give ${CUSTOMER_TABLE} a nullable \`deleted_at text\` column. When a ` +
      `customer (a ${CUSTOMER_TABLE} row) is deleted, its rows in ${REFERENCING_TABLE} (which references ${CUSTOMER_TABLE} ` +
      `through its parent_id column) must also be removed. Ship the change with a migration.`,
    async check(dir) {
      const common = commonChecks(dir, scaleConfigArg);
      if (common) return common;
      const migration = migrationMatches(dir, /add column\s+"?deleted_at"?\s+text/i, "scale");
      if (!migration.ok) return migration;
      return checkCascadeDelete(dir, "scale", "flat");
    },
  },
];
