// Responsibility: the functional check both cross-module scenarios share --
// replay a scale starter's migrations into a private node:sqlite database,
// insert one customer row and one referencing row, run the built module's
// own command that deletes the customer, and (if that alone did not remove
// the referencing row) find and run a second command that does, then assert
// it is gone.
// Boundary: pure check logic only. cascade-check-worker.ts runs this in its
// own process (see that file for why); scale-project.ts's checkCascadeDelete
// spawns that worker instead of calling this directly, to guarantee no
// import of these files ever comes from Node's module cache.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
// check below can find "a command that deletes from t3" (or t4) without
// knowing what the fix named it -- the build already refuses a plan that
// writes another module's table (confirmed against this generator: an
// on-delete-cascade foreign key from t4 into t3 is refused the same way,
// since deleting a t3 row would then also delete t4 rows through a command
// t3 does not own), so a correct owned-arm fix is necessarily two commands,
// one per module, not one plan or one trigger.
function commandsOf(moduleNamespace: Record<string, unknown>): PlanCommand[] {
  const found: PlanCommand[] = [];
  for (const value of Object.values(moduleNamespace)) {
    if (isPlanCommands(value)) found.push(...Object.values(value.entries));
  }
  return found;
}

function findDelete(commandsList: readonly PlanCommand[], table: string): PlanCommand | undefined {
  const pattern = new RegExp(`^\\s*delete\\s+from\\s+"?${table}"?\\b`, "i");
  return commandsList.find(c => c.plan.some(item => typeof item === "string" && pattern.test(item)));
}

// Every named parameter a command's plan mentions, bound to the same value
// (the deleted customer's id) -- every generated and fix command in this
// project takes one id-shaped parameter per delete statement, so this
// binding covers the shapes the stub and the generator itself produce. A
// fix whose command needs an unrelated parameter is outside what this check
// exercises; the README names that limit.
function paramsFor(command: PlanCommand, value: string): Record<string, string> {
  const names = new Set<string>();
  for (const item of command.plan) {
    if (typeof item !== "string") continue;
    for (const m of item.matchAll(/:(\w+)/g)) names.add(m[1]!);
  }
  return Object.fromEntries([...names].map(name => [name, value]));
}

export async function runCascadeCheck(dir: string, project: string, arm: Arm): Promise<CascadeCheckResult> {
  const projectDir = join(dir, project);
  const { migrations } = (await import(pathToFileURL(join(projectDir, "migrations/index.ts")).href)) as { migrations: readonly { name: string; sql: string }[] };
  const { node, migrate } = (await import(pathToFileURL(join(dir, "src/node.ts")).href)) as typeof import("../../src/node.ts");
  const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db, migrations);
    db.prepare(`insert into ${CUSTOMER_TABLE} (id, a, b, n, r) values ('customer-1', 'a', 'b', 1, 1.0)`).run();
    db.prepare(`insert into ${REFERENCING_TABLE} (id, parent_id, a, b, n, r) values ('ref-1', 'customer-1', 'a', 'b', 1, 1.0)`).run();

    const ownerPath = join(projectDir, arm === "flat" ? "all/module.ts" : `${CUSTOMER_TABLE}/module.ts`);
    const referencerPath = join(projectDir, arm === "flat" ? "all/module.ts" : `${REFERENCING_TABLE}/module.ts`);
    const ownerCommands = commandsOf((await import(pathToFileURL(ownerPath).href)) as Record<string, unknown>);
    const referencerCommands = referencerPath === ownerPath ? ownerCommands : commandsOf((await import(pathToFileURL(referencerPath).href)) as Record<string, unknown>);

    const deleteCustomer = findDelete(ownerCommands, CUSTOMER_TABLE);
    if (!deleteCustomer) return { ok: false, reason: `no command in the built module deletes from ${CUSTOMER_TABLE}` };
    const adapter = node(db);
    await adapter.run(deleteCustomer as never, paramsFor(deleteCustomer, "customer-1") as never);

    const remainingAfterCustomerDelete = db.prepare(`select count(*) as n from ${REFERENCING_TABLE} where parent_id = 'customer-1'`).get() as { n: number };
    if (remainingAfterCustomerDelete.n === 0) return { ok: true };

    const deleteReferencing = findDelete(referencerCommands, REFERENCING_TABLE);
    if (!deleteReferencing) return { ok: false, reason: `${REFERENCING_TABLE} still references the deleted ${CUSTOMER_TABLE} row, and no command deletes from ${REFERENCING_TABLE} by that row's id` };
    await adapter.run(deleteReferencing as never, paramsFor(deleteReferencing, "customer-1") as never);

    const remaining = db.prepare(`select count(*) as n from ${REFERENCING_TABLE} where parent_id = 'customer-1'`).get() as { n: number };
    if (remaining.n !== 0) return { ok: false, reason: `${REFERENCING_TABLE} still has ${remaining.n} row(s) referencing the deleted ${CUSTOMER_TABLE} row` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `cascade check: ${String(error)}` };
  } finally {
    db.close();
  }
}
