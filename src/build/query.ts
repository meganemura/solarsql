// Responsibility: resolve <module>.<catalog>.<name> against a loaded
// configuration and run it against a local SQLite file, read-only.
// Boundary: no SQL text and no typing here. load() (build.ts) already
// imports the project and its generated types; this file only walks the
// imported module's own exports for the one catalog entry the CLI named,
// and hands the resulting Query object to node()'s own adapter, which
// validates parameters (ADR 0088) and decodes JSON. A write statement
// cannot be a query (ADR 0045), so a read-only handle is enough; running a
// command is refused here instead of attempted through it.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Entry, Query } from "../index.ts";
import { node } from "../node.ts";
import { load } from "./build.ts";
import { BuildError } from "./typegen.ts";

export type QueryTarget = { module: string; catalog: string; name: string };

// <module>.<catalog>.<name>: the module's directory basename, the exported
// catalog const, and the entry key, matching how queries.md and running.md
// already name a query.
export function parseQueryTarget(spec: string): QueryTarget {
  const parts = spec.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new BuildError(`query name must be <module>.<catalog>.<name>: ${spec}`);
  }
  const [module, catalog, name] = parts as [string, string, string];
  return { module, catalog, name };
}

// The catalog entry the target names: a Query object ready for node()'s
// own all(), or a refusal naming db.run when the target is a command.
async function resolveQuery(configPath: string, target: QueryTarget): Promise<Query<string, Entry>> {
  const loaded = await load(configPath, false);
  const mod = loaded.modules.find((m) => m.name === target.module);
  if (!mod) throw new BuildError(`no module named ${JSON.stringify(target.module)} in ${configPath}`);
  const exports = (await import(pathToFileURL(join(mod.dir, "module.ts")).href)) as Record<string, unknown>;
  const catalog = exports[target.catalog] as { kind?: unknown; entries?: Record<string, unknown> } | undefined;
  if (!catalog || typeof catalog !== "object" || (catalog.kind !== "queries" && catalog.kind !== "commands")) {
    throw new BuildError(`no query catalog named ${JSON.stringify(target.catalog)} in module ${target.module}`);
  }
  if (catalog.kind === "commands") {
    throw new BuildError(`${target.module}.${target.catalog}.${target.name} is a command, not a query. Run a command through db.run, not this CLI.`);
  }
  const query = catalog.entries?.[target.name] as Query<string, Entry> | undefined;
  if (!query || query.kind !== "query") {
    throw new BuildError(`no query named ${JSON.stringify(target.name)} in ${target.module}.${target.catalog}`);
  }
  return query;
}

// Open the database read-only, resolve the query, and run it. The database
// path names itself in a failed open, the same way the CLI's other options
// name themselves on a bad value.
export async function runQuery(configPath: string, target: QueryTarget, databasePath: string, params: Record<string, unknown>): Promise<unknown[]> {
  const query = await resolveQuery(configPath, target);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
  } catch (e) {
    throw new BuildError(`--database ${databasePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return await node(db).all(query, params);
  } finally {
    db.close();
  }
}
