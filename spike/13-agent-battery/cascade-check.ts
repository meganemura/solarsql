// Responsibility: the functional check both cross-module scenarios share --
// replay a scale starter's migrations into a private node:sqlite database,
// insert one customer row and one referencing row, find (by structure, not
// by name) a command that deletes the referencing rows by a parameter, run
// it, then find a command that deletes the customer by id, run that, and
// assert both rows are gone. The referencing table goes first because the
// library refuses a customer-table command that also writes the referencing
// table (commands.md, "What a plan may touch"), so a caller must clear the
// referencing rows itself; a flat-arm command whose one plan does both is
// still found and accepted at both steps, the second run a no-op.
// Boundary: pure check logic only. cascade-check-worker.ts runs this in its
// own process (see that file for why); scale-project.ts's checkCascadeDelete
// spawns that worker instead of calling this directly, to guarantee no
// import of these files ever comes from Node's module cache.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

// t10/t11, not the lower-numbered pair a reader might expect: t{i} always
// references t{i-1}, so deleting a customer row also reads the delete
// target's own children for a foreign-key check (build.md, "A delete from a
// parent table reads the foreign key columns of its children"). t11 is the
// last module (N=12, spike/12-build-scale.ts's SCALE_N), so it has no child
// of its own to pull an unrelated table into that read set; any lower pair
// (t3/t4, say) would legitimately mention t5 in the fix's own generated
// metadata, which is not a harmful edit but would look like one to
// hunksOutsideTask's per-line table-name scan.
export const CUSTOMER_TABLE = "t10";
export const REFERENCING_TABLE = "t11";

export type Arm = "owned" | "flat";
export type CascadeCheckResult = { ok: boolean; reason?: string };

// A command catalog's own entries (Commands.entries, src/index.ts), read at
// runtime -- `commands()` keeps each plan's literal SQL strings on the
// object it returns, so a catalog built by an agent under any export name
// is still readable without recompiling or guessing that name.
type PlanCommand = { kind: "command"; name: string; plan: readonly (string | { kind: "assert" })[] };
type PlanCommands = { kind: "commands"; entries: Record<string, PlanCommand> };

function isPlanCommands(value: unknown): value is PlanCommands {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "commands";
}

// Every command of every exported catalog in a module's namespace, so the
// check below can find "a command that deletes from t11" without knowing
// what the fix named it -- the build already refuses a plan that writes
// another module's table (confirmed against this generator: an
// on-delete-cascade foreign key from t11 into t10 is refused the same way,
// since deleting a t10 row would then also delete t11 rows through a
// command t10 does not own), so a correct owned-arm fix is necessarily two
// commands, one per module, not one plan or one trigger.
function commandsOf(moduleNamespace: Record<string, unknown>): PlanCommand[] {
  const found: PlanCommand[] = [];
  for (const value of Object.values(moduleNamespace)) {
    if (isPlanCommands(value)) found.push(...Object.values(value.entries));
  }
  return found;
}

function deletesFromTable(item: string, table: string): boolean {
  return new RegExp(`^\\s*delete\\s+from\\s+"?${table}"?\\b`, "i").test(item);
}

// The first command whose plan deletes from `table` -- used only for the
// customer-table step, where exactly one such command is expected (the
// generator's own delete-by-id), so declaration order does not matter.
function findDelete(commandsList: readonly PlanCommand[], table: string): PlanCommand | undefined {
  return commandsList.find(c => c.plan.some(item => typeof item === "string" && deletesFromTable(item, table)));
}

// Every command in `commandsList` whose plan deletes from `table` through a
// named parameter, ordered so a command that deletes by the referencing
// column (its delete statement itself mentions parent_id) is tried before
// one that does not (a delete by t11's own id, which the earlier version of
// this check picked by declaration order alone -- run 1 of the
// 2026-09-19 owned-arm battery added `deleteByParent` after the generator's
// own by-id deletes, and the old `.find` returned the first of those
// instead, silently deleting zero rows). A plan with no parameter (a
// hypothetical "delete from t11" with no where clause) is excluded: nothing
// here could target it at the one customer under test.
function deleteCandidates(commandsList: readonly PlanCommand[], table: string): PlanCommand[] {
  const withParams = commandsList.filter(c => c.plan.some(item => typeof item === "string" && deletesFromTable(item, table)) && paramNames(c).size > 0);
  const byParentId = withParams.filter(c => c.plan.some(item => typeof item === "string" && deletesFromTable(item, table) && /\bparent_id\b/i.test(item)));
  const rest = withParams.filter(c => !byParentId.includes(c));
  return [...byParentId, ...rest];
}

function paramNames(command: PlanCommand): Set<string> {
  const names = new Set<string>();
  for (const item of command.plan) {
    if (typeof item !== "string") continue;
    for (const m of item.matchAll(/:(\w+)/g)) names.add(m[1]!);
  }
  return names;
}

// Every named parameter a command's plan mentions, bound to the same value
// (the deleted customer's id) -- every generated and fix command in this
// project takes one id-shaped parameter per delete statement, so this
// binding covers the shapes the stub and the generator itself produce. A
// fix whose command needs an unrelated parameter is outside what this check
// exercises; the README names that limit.
function paramsFor(command: PlanCommand, value: string): Record<string, string> {
  return Object.fromEntries([...paramNames(command)].map(name => [name, value]));
}

export async function runCascadeCheck(dir: string, project: string, arm: Arm): Promise<CascadeCheckResult> {
  const projectDir = join(dir, project);
  const { migrations } = (await import(pathToFileURL(join(projectDir, "migrations/index.ts")).href)) as { migrations: readonly { name: string; sql: string }[] };
  const { node, migrate } = (await import(pathToFileURL(join(dir, "src/node.ts")).href)) as typeof import("../../src/node.ts");
  const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");

  function freshDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    migrate(db, migrations);
    db.prepare(`insert into ${CUSTOMER_TABLE} (id, a, b, n, r) values ('customer-1', 'a', 'b', 1, 1.0)`).run();
    db.prepare(`insert into ${REFERENCING_TABLE} (id, parent_id, a, b, n, r) values ('ref-1', 'customer-1', 'a', 'b', 1, 1.0)`).run();
    return db;
  }

  function referencingCount(db: DatabaseSync): number {
    return (db.prepare(`select count(*) as n from ${REFERENCING_TABLE} where parent_id = 'customer-1'`).get() as { n: number }).n;
  }

  try {
    const ownerPath = join(projectDir, arm === "flat" ? "all/module.ts" : `${CUSTOMER_TABLE}/module.ts`);
    const referencerPath = join(projectDir, arm === "flat" ? "all/module.ts" : `${REFERENCING_TABLE}/module.ts`);
    const ownerCommands = commandsOf((await import(pathToFileURL(ownerPath).href)) as Record<string, unknown>);
    const referencerCommands = referencerPath === ownerPath ? ownerCommands : commandsOf((await import(pathToFileURL(referencerPath).href)) as Record<string, unknown>);

    const referencingCandidates = deleteCandidates(referencerCommands, REFERENCING_TABLE);
    if (referencingCandidates.length === 0) {
      return { ok: false, reason: `no command in the built module deletes from ${REFERENCING_TABLE} by a parameter` };
    }

    // Try each candidate on its own fresh database (a wrong candidate may
    // delete nothing, or the wrong rows, or throw -- none of that should
    // poison the database the accepted candidate continues on).
    let workingDb: DatabaseSync | undefined;
    for (const candidate of referencingCandidates) {
      const db = freshDb();
      let cleared = false;
      try {
        await node(db).run(candidate as never, paramsFor(candidate, "customer-1") as never);
        cleared = referencingCount(db) === 0;
      } catch {
        cleared = false;
      }
      if (cleared) {
        workingDb = db;
        break;
      }
      db.close();
    }
    if (!workingDb) {
      return { ok: false, reason: `${REFERENCING_TABLE} still references the deleted ${CUSTOMER_TABLE} row, and no command found by structure clears it` };
    }

    try {
      const deleteCustomer = findDelete(ownerCommands, CUSTOMER_TABLE);
      if (deleteCustomer) {
        await node(workingDb).run(deleteCustomer as never, paramsFor(deleteCustomer, "customer-1") as never);
      }
      const survivor = workingDb.prepare(`select * from ${CUSTOMER_TABLE} where id = 'customer-1'`).get() as Record<string, unknown> | undefined;
      if (survivor) {
        const deletedAt = "deleted_at" in survivor ? survivor.deleted_at : undefined;
        return { ok: false, reason: `the task asked for a delete and the ${CUSTOMER_TABLE} row remains (deleted_at = ${JSON.stringify(deletedAt)})` };
      }
      const remaining = referencingCount(workingDb);
      if (remaining !== 0) {
        return { ok: false, reason: `${REFERENCING_TABLE} still has ${remaining} row(s) referencing the deleted ${CUSTOMER_TABLE} row` };
      }
      return { ok: true };
    } finally {
      workingDb.close();
    }
  } catch (error) {
    return { ok: false, reason: `cascade check: ${String(error)}` };
  }
}
