// Responsibility: `solarsql build` and `solarsql migration`. Read the
// configuration, import every module, type every statement with the
// engine, check the module boundaries, write the generated files, and
// compare the migration files with the declared schema.
// Boundary: this file owns the module layout and the file system. The
// facts come from facts.ts, the types from typegen.ts, the file text from
// emit.ts, and the migration statements from migration.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command, Config, Index, ModuleConfig, PlanItem, Query, Search, Table, Trigger, View } from "../index.ts";
import { GUARD_DDL, GUARD_TABLE, assertStatement } from "../runtime/plan.ts";
import { GENERATED_FILE, emitGenerated, emitMigrationsIndex, emitStub } from "./emit.ts";
import { Engine, type Access, type OutputColumn } from "./facts.ts";
import { applied, diff, introspect, open, type DropIntent, type Rename, type RenameRepair } from "./migration.ts";
import type { MigrationIntent } from "./migration-intent.ts";
import { migrationSequence, nextMigrationFile, withMigrationLock, writeNewMigration } from "./migration-files.ts";
import { created, definitions, indexTarget, isKeyword, quoteIdent, significant, tokenize, triggerTarget, type RebuildRecord } from "./scan.ts";
import { sqliteName } from "./scope.ts";
import { shellArgument } from "./shell.ts";
import { writeGeneratedFile } from "./output.ts";
import { BuildError, Typer, brandName, isSelect, type Analysis, type Brand } from "./typegen.ts";
import { catalogStatement } from "./statements.ts";

export type Module = {
  name: string;
  dir: string;
  // The time the module file took to import. A slow build is usually a
  // slow import, and the per-module time in the CLI adds this to the typing.
  importMs: number;
  readsAll: boolean;
  tables: string[];
  indexes: string[];
  searches: string[];
  views: string[];
  triggers: string[];
  // Every statement the module runs, keyed by what the generated map keys it
  // on: the SQL of a query or statement, or the predicate of an assert.
  statements: Map<string, string>;
  // SQL can appear in several catalogs or plan positions; diagnostics name each use.
  statementUses: Map<string, string[]>;
  readStatements: Set<string>;
  // The queries by catalog name, in catalog order: `statements` is keyed by
  // SQL, and the reads report names the query.
  queries: { name: string; sql: string }[];
  commands: { name: string; catalog: string; plan: readonly PlanItem[]; returns: string | null }[];
};

export type BuildOptions = {
  // false: write nothing, and report what a build would change. For CI
  // and for a test hook, through `solarsql build --check`. Default true.
  write?: boolean;
  inspect?: boolean;
};

export type OperationInspection = {
  module: string;
  sql: string;
  locations: readonly string[];
  params: Analysis["params"];
  columns: Analysis["columns"];
  origins: OutputColumn[];
  accesses: Access[];
  reads: string[];
};

export type BuildResult = {
  inspection?: { sqlite: string; operations: OperationInspection[] };
  // Per module: the statements this build added to and removed from the
  // generated file, so the CLI can say what changed.
  modules: { name: string; generatedPath: string; entries: number; changed: boolean; added: string[]; removed: string[]; ms: number }[];
  migration: { pending: boolean; statements: string[]; reason: string | null; drops?: DropIntent[]; renames?: Rename[]; renameCandidates?: RenameRepair[]; rebuilds?: RebuildRecord[] };
  // The bundle of the migration files a Durable Object imports. It is a
  // generated file too: the build rewrites it when a migration file changed,
  // and a check reports it stale. `path` is null when there are no files.
  index: { path: string | null; changed: boolean };
  // Statements whose plan scans a table in full despite a WHERE clause.
  scans: { module: string; sql: string; tables: string[] }[];
  // The tables each query of a readsAll module reads. Only there: another
  // module reads its own tables and the keys of its foreign keys.
  reads: { module: string; query: string; tables: string[] }[];
  // The whole build, so the module times can be compared with the rest.
  ms: number;
};

export type Loaded = { config: Config; configDir: string; modules: Module[] };

// The module files, imported. A generated file that is missing gets a stub
// before the import, so a module imports before the first build (ADR 0025,
// ADR 0040): the stub of every listed module before any module is
// imported, since a module may import a module listed after it; and the
// stub a config that imports a module asks for. A check that writes
// nothing stops at a missing generated file instead.
export async function load(configPath: string, write = true): Promise<Loaded> {
  const absolute = resolve(configPath);
  const configDir = dirname(absolute);
  const stubbed: string[] = [];
  const config = (await importConfig(absolute, write, stubbed, configPath)).default as Config | undefined;
  if (!config || !Array.isArray(config.modules) || typeof config.migrations !== "string") {
    throw new BuildError(`${configPath} must export default config({ modules: [...], migrations: "..." })`);
  }
  const library = config.library ?? "solarsql";
  const listed = config.modules.map((entry) => {
    const mc: ModuleConfig = typeof entry === "string" ? { dir: entry } : entry;
    return { mc, dir: resolve(configDir, mc.dir) };
  });
  for (const { dir } of listed) {
    const name = basename(dir);
    const source = join(dir, "module.ts");
    if (!existsSync(source)) throw new BuildError(`module ${name}: ${source} does not exist`);
    const generatedPath = join(dir, GENERATED_FILE);
    if (!existsSync(generatedPath)) {
      if (!write) throw new BuildError(`module ${name}: ${generatedPath} is missing. Run: npx solarsql build ${shellArgument(configPath)}`, undefined, `Run \`npx solarsql build ${shellArgument(configPath)}\`.`);
      writeGeneratedFile(generatedPath, emitStub(library));
    }
  }
  // A module the config imports but does not list would keep its stub for
  // ever, since no build fills it: the stub goes, and the message names the
  // entry to add. The other stubs get the library specifier, known now.
  // Node names the file by its real path, and the configuration may sit
  // under a symbolic link, so the comparison is between real paths.
  const unlisted = stubbed.filter((path) => !listed.some((l) => realpathSync(l.dir) === realpathSync(dirname(path))));
  for (const path of unlisted) unlinkSync(path);
  if (unlisted[0] !== undefined) {
    const dir = dirname(unlisted[0]);
    throw new BuildError(`module ${basename(dir)}: ${basename(absolute)} imports it, and it is not in modules. Add ${JSON.stringify(`./${relative(realpathSync(configDir), dir).split("\\").join("/")}`)} to modules.`);
  }
  for (const path of stubbed) writeGeneratedFile(path, emitStub(library));
  const modules: Module[] = [];
  for (const { mc, dir } of listed) {
    const name = basename(dir);
    const source = join(dir, "module.ts");
    const tables: string[] = [];
    const indexes: string[] = [];
    const searches: string[] = [];
    const views: string[] = [];
    const triggers: string[] = [];
    const statements = new Map<string, string>();
    const statementUses = new Map<string, string[]>();
    const readStatements = new Set<string>();
    const use = (key: string, location: string): void => {
      statementUses.set(key, [...(statementUses.get(key) ?? []), `${source}: ${location}`]);
    };
    const statement = (key: string, sql: string, role: "read" | "plan", location: string): void => {
      use(key, location);
      if (role === "read") readStatements.add(key);
      try { statements.set(key, catalogStatement(sql, role)); }
      catch (error) { throw withLocations(error, [`${source}: ${location}`], sql); }
    };
    const queries: Module["queries"] = [];
    const commands: Module["commands"] = [];
    // One file exports the schema, the queries, and the commands (ADR 0033).
    const importStarted = performance.now();
    const exports = await importFresh(source);
    const importMs = performance.now() - importStarted;
    for (const [catalog, value] of Object.entries(exports)) {
      const v = value as (Table | Index | Search | View | Trigger | { kind: "queries"; entries: Record<string, Query<string, never>> } | { kind: "commands"; entries: Record<string, Command<never, never>> }) | null;
      if (!v || typeof v !== "object" || !("kind" in v)) continue;
      if (v.kind === "table") tables.push(v.sql);
      if (v.kind === "index") indexes.push(v.sql);
      if (v.kind === "search") searches.push(v.sql);
      if (v.kind === "view") views.push(v.sql);
      if (v.kind === "trigger") triggers.push(v.sql);
      if (v.kind === "queries") {
        for (const [entry, q] of Object.entries(v.entries)) {
          statement(q.sql, q.sql, "read", `query ${catalog}.${entry}`);
          queries.push({ name: q.name, sql: q.sql });
        }
      }
      if (v.kind === "commands") {
        for (const [cname, c] of Object.entries(v.entries)) {
          commands.push({ name: cname, catalog, plan: c.plan, returns: c.returns });
          for (const [position, item] of c.plan.entries()) {
            const key = typeof item === "string" ? item : item.predicate;
            statement(key, typeof item === "string" ? item : assertStatement(item.name, item.predicate), "plan",
              `command ${catalog}.${cname}, plan item ${position + 1}${typeof item === "string" ? "" : `, assert ${item.name}`}`);
          }
          if (c.returns !== null) {
            statement(c.returns, c.returns, "read", `command ${catalog}.${cname}, returns`);
          }
        }
      }
    }
    modules.push({ name, dir, importMs, readsAll: mc.readsAll ?? false, tables, indexes, searches, views, triggers, statements, statementUses, readStatements, queries, commands });
  }
  return { config, configDir, modules };
}

// The configuration file, imported. It may import a module through its
// public.ts, and the module imports its generated file, which a fresh
// clone lacks. Node names the file it cannot find; when that file is the
// generated file of a module, the build writes the stub and imports again.
// The same path twice means the stub did not help, and the error stands.
async function importConfig(absolute: string, write: boolean, stubbed: string[], configPath: string): Promise<Record<string, unknown>> {
  for (;;) {
    try {
      return await importFresh(absolute);
    } catch (e) {
      const missing = missingGeneratedFile(e);
      if (missing === null || stubbed.includes(missing)) throw e;
      const name = basename(dirname(missing));
      if (!write) throw new BuildError(`module ${name}: ${missing} is missing. Run: npx solarsql build ${shellArgument(configPath)}`, undefined, `Run \`npx solarsql build ${shellArgument(configPath)}\`.`);
      // The library specifier is in the config, which has not loaded yet;
      // load() rewrites the stub once it has. The import is type-only, so
      // the specifier does not matter for this import.
      writeGeneratedFile(missing, emitStub("solarsql"));
      stubbed.push(missing);
    }
  }
}

// The path of the generated file an import could not find, when the error
// is that and a module.ts sits beside the file; else null.
function missingGeneratedFile(e: unknown): string | null {
  if (!e || typeof e !== "object" || (e as { code?: unknown }).code !== "ERR_MODULE_NOT_FOUND") return null;
  const url = (e as { url?: unknown }).url;
  if (typeof url !== "string" || !url.startsWith("file:")) return null;
  const path = fileURLToPath(url);
  if (basename(path) !== GENERATED_FILE || !existsSync(join(dirname(path), "module.ts"))) return null;
  return path;
}

// The statements of `after` that `before` lacks, and the other way round,
// in their own order. A reader of the CLI output sees the change without a
// second look at the generated file.
export function keyDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((k) => !b.has(k)), removed: before.filter((k) => !a.has(k)) };
}

async function importFresh(path: string): Promise<Record<string, unknown>> {
  // A query string defeats the module cache, so a second build in the same
  // process sees the files as they are now.
  const url = `${pathToFileURL(path).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return (await import(url)) as Record<string, unknown>;
}

// The declared schema: every table and index of every module, plus the
// guard table and its trigger.
// Tables first, then indexes, search tables, views, and triggers, since a
// view reads tables and a trigger body may write a search table.
export function declaredDdl(modules: readonly Module[]): string[] {
  return [
    ...modules.flatMap((m) => m.tables),
    ...modules.flatMap((m) => m.indexes),
    ...modules.flatMap((m) => m.searches),
    ...modules.flatMap((m) => m.views),
    ...modules.flatMap((m) => m.triggers),
    ...GUARD_DDL,
  ];
}

// A foreign key declared DEFERRABLE INITIALLY DEFERRED resolves at the
// enclosing transaction's commit, not at the write that violates it.
// pragma_foreign_key_list (facts.ts's foreignKeys) never carries this
// modifier, so the check works from the table's own declared SQL text.
// Only the exact three-token sequence counts: NOT DEFERRABLE, a bare
// DEFERRABLE, and DEFERRABLE INITIALLY IMMEDIATE are all SQLite's ordinary
// immediate behavior and must not be refused (measured in node:sqlite:
// only DEFERRABLE INITIALLY DEFERRED defers a foreign-key exception past
// the writing transactionSync closure). A plain substring match on
// "deferrable" would also refuse a column merely named `deferrable`.
function deferredForeignKeyDeclaration(sql: string): { column: string } | { constraint: string } | null {
  const isDeferredInitiallyDeferred = (text: string): boolean => {
    const t = significant(tokenize(text));
    return t.some((tok, i) => isKeyword(tok, "deferrable") && isKeyword(t[i + 1], "initially") && isKeyword(t[i + 2], "deferred"));
  };
  const defs = definitions(sql);
  if (!defs) return null;
  for (const [name, def] of defs.columns) if (isDeferredInitiallyDeferred(def)) return { column: name };
  for (const constraint of defs.constraints) if (isDeferredInitiallyDeferred(constraint)) return { constraint };
  return null;
}

export async function build(configPath: string, options: BuildOptions = {}): Promise<BuildResult> {
  const buildStarted = performance.now();
  const write = options.write ?? true;
  const loaded = await load(configPath, write);
  return buildLoaded(loaded, options, buildStarted);
}

// build()'s own check body. migration() calls this on a configuration it
// has already loaded itself, so a schema or command change that would fail
// build() also fails migration() before a migration file exists (ADR
// 0096), without importing the configuration file a second time: the
// import's own side effects (a `process.on` listener, for one, in a test
// harness) would otherwise run twice.
async function buildLoaded(loaded: Loaded, options: BuildOptions, buildStarted = performance.now()): Promise<BuildResult> {
  const write = options.write ?? true;
  const { config, configDir, modules } = loaded;
  const library = config.library ?? "solarsql";
  checkImports(modules);

  // Ownership: one module per table.
  const owner = new Map<string, Module>();
  // The table's own declared SQL text, keyed by table name, for the one
  // check below (deferred foreign keys) that pragma_foreign_key_list
  // cannot answer and so must read the original CREATE TABLE string.
  const declaredTableSql = new Map<string, string>();
  for (const m of modules) {
    for (const sql of m.tables) {
      const c = created(sql);
      if (!c || c.kind !== "table") throw new BuildError(`module ${m.name}: table() needs one CREATE TABLE statement`, sql);
      const other = owner.get(c.name);
      if (other) throw new BuildError(`table ${c.name} is declared by module ${other.name} and by module ${m.name}`);
      owner.set(c.name, m);
      declaredTableSql.set(c.name, sql);
    }
    for (const sql of m.indexes) {
      const c = created(sql);
      if (!c || c.kind !== "index") throw new BuildError(`module ${m.name}: index() needs one CREATE INDEX statement`, sql);
    }
    for (const sql of m.searches) {
      const c = created(sql);
      if (!c || c.kind !== "virtual" || !/\busing\s+fts5\s*\(/i.test(sql)) throw new BuildError(`module ${m.name}: search() needs one CREATE VIRTUAL TABLE ... USING fts5(...) statement`, sql);
      const other = owner.get(c.name);
      if (other) throw new BuildError(`table ${c.name} is declared by module ${other.name} and by module ${m.name}`);
      owner.set(c.name, m);
    }
    for (const sql of m.views) {
      const c = created(sql);
      if (!c || c.kind !== "view") throw new BuildError(`module ${m.name}: view() needs one CREATE VIEW statement`, sql);
    }
  }
  // An index sits on a table of its own module: it is part of that table's
  // shape, and the migration of the owner carries it.
  for (const m of modules) {
    for (const sql of m.indexes) {
      const target = indexTarget(sql);
      if (!target) throw new BuildError(`module ${m.name}: index() needs one CREATE INDEX statement with ON <table>`, sql);
      const o = owner.get(target.table);
      if (o !== m) throw new BuildError(`module ${m.name}: index ${target.name} is on ${target.table}, which ${o ? `module ${o.name} owns` : "no module declares"}. An index belongs to the module of its table.`, sql);
    }
  }
  // A trigger sits on a table or a view of its own module.
  const viewOwner = new Map<string, Module>();
  for (const m of modules) for (const sql of m.views) viewOwner.set(created(sql)!.name, m);
  for (const m of modules) {
    for (const sql of m.triggers) {
      const t = triggerTarget(sql);
      if (!t) throw new BuildError(`module ${m.name}: trigger() needs one CREATE TRIGGER statement with BEFORE, AFTER, or INSTEAD OF, an event, and ON <table or view>`, sql);
      const o = owner.get(t.table) ?? viewOwner.get(t.table);
      if (o !== m) throw new BuildError(`module ${m.name}: trigger ${t.name} is on ${t.table}, which ${o ? `module ${o.name} owns` : "no module declares"}. A trigger belongs to the module of its table or view.`, sql);
    }
  }

  let engine: Engine;
  try {
    engine = new Engine(declaredDdl(modules));
  } catch (e) {
    throw new BuildError(`schema: ${(e as Error).message}`);
  }
  try {
    const brands = new Map<string, Brand>();
    const tables = engine.tables();
    const byName = new Map(tables.map((t) => [sqliteName(t.name), t]));
    for (const t of tables) {
      const pk = t.columns.filter((c) => c.pk > 0);
      const m = owner.get(t.name);
      if (!m || t.virtual) continue;
      if (pk.length === 0) throw new BuildError(`table ${t.name} has no primary key. Declare one: id text primary key not null.`);
      // A STRICT table makes its primary key NOT NULL by itself, so the id
      // brand is never nullable (ADR 0018, ADR 0029).
      if (!t.strict) {
        throw new BuildError(`table ${t.name} is not STRICT. Add \`strict\` after the closing parenthesis, so the engine rejects a value that does not match the declared type.`);
      }
      // pragma_foreign_key_list echoes whatever a REFERENCES clause
      // declares, with no check that the target resolves. SQLite itself
      // only validates a foreign key against real rows at write time, so a
      // stale or misspelled target would otherwise pass every build check
      // here, apply cleanly as a migration, and only fail on the table's
      // first write in production.
      for (const fk of t.foreignKeys) {
        const target = byName.get(sqliteName(fk.table));
        if (!target) throw new BuildError(`table ${t.name} has a foreign key to ${fk.table}, which no module declares. Fix the table name, or declare the missing table.`);
        // An omitted column list resolves to the target's own primary key.
        const targetColumn = fk.to ?? target.columns.find((c) => c.pk > 0)?.name ?? null;
        if (!targetColumn || !target.columns.some((c) => sqliteName(c.name) === sqliteName(targetColumn!))) {
          throw new BuildError(`table ${t.name} has a foreign key to ${fk.table}(${fk.to ?? "its primary key"}), which has no such column. Fix the column name, or declare it on ${fk.table}.`);
        }
      }
      // A DEFERRABLE INITIALLY DEFERRED foreign key resolves at commit, not
      // at the write that violates it. D1 and the Durable Object adapter
      // cannot classify that failure the way an immediate foreign key's
      // failure is classified: on D1, run() falls through to an
      // unclassified throw; on a Durable Object, run()'s caller observes a
      // false success before the platform discards the response and resets
      // storage. Refuse the declaration itself, since neither target can be
      // fixed to catch it.
      const deferred = declaredTableSql.has(t.name) ? deferredForeignKeyDeclaration(declaredTableSql.get(t.name)!) : null;
      if (deferred) {
        const where = "column" in deferred ? `column ${deferred.column}` : `table constraint \`${deferred.constraint}\``;
        throw new BuildError(
          `table ${t.name} declares a foreign key as DEFERRABLE INITIALLY DEFERRED (${where}). D1 and the Durable Object adapter cannot classify or catch a violation of it: it surfaces as an opaque platform error, or, on a Durable Object, as a false success the caller cannot detect before the platform resets storage. Declare the key immediate instead (SQLite's own default: omit DEFERRABLE, or write NOT DEFERRABLE or DEFERRABLE INITIALLY IMMEDIATE), and order the command's plan to insert the referenced row first. solarsql's own generated migrations use \`pragma defer_foreign_keys = on\` for a rebuild, but that is a session-scoped pragma, not a permanent schema declaration, and this refusal does not apply to it.`,
        );
      }
      // Id is a string contract. Other primary keys retain their storage type.
      if (pk.length === 1 && pk[0]!.type.toUpperCase() === "TEXT") brands.set(t.name, { table: t.name, column: pk[0]!.name, typeName: brandName(t.name), module: m.name });
    }
    for (const m of modules) {
      // A view's own CREATE VIEW is not compiled at CREATE, so a function
      // call in its body is only ever checked here, by preparing a select
      // against it -- the same statement checkBoundary below inspects for
      // table accesses. An orphan view (no query in this module selects it)
      // would otherwise never be prepared at all (ADR 0114).
      for (const sql of m.views) {
        const name = created(sql)!.name;
        const select = `select * from ${quoteIdent(name)}`;
        try {
          engine.prepare(select);
        } catch (e) {
          throw new BuildError(`module ${m.name}: view ${name}: ${(e as Error).message}`, sql);
        }
        checkBoundary(engine, m, owner, select, `view ${name}`);
      }
      for (const sql of m.triggers) checkTriggerBoundary(engine, m, owner, sql);
    }
    const typer = new Typer(engine, brands);
    const brandModule = new Map([...brands.values()].map((b) => [b.typeName, b.module]));
    const results: BuildResult["modules"] = [];
    const scans: BuildResult["scans"] = [];
    const reads: BuildResult["reads"] = [];
    const operations: OperationInspection[] = [];

    for (const m of modules) {
      const entries: { key: string; analysis: Analysis }[] = [];
      const used = new Set<string>();
      const typeStarted = performance.now();
      for (const [key, sql] of m.statements) {
        let analysis: Analysis;
        try {
          if (m.readStatements.has(key) && engine.accesses(sql).some((access) => ["insert", "update", "delete"].includes(access.action))) {
            throw new BuildError("A query or returns must not write to the database.", sql);
          }
          analysis = typer.analyze(sql, m.name);
          // A plan item's own rows are never collected at run time; only a
          // command's `returns` clause is. A write plan item with its own
          // RETURNING clause would silently drop that data, so refuse it
          // here. A select/values plan item is unaffected: it is a
          // documented, valid plan item on its own terms.
          if (!m.readStatements.has(key) && !isSelect(sql) && analysis.returnsRows) {
            throw new BuildError("A plan item's RETURNING clause is discarded at run time. Move the read into the command's `returns` field instead.", sql);
          }
          checkBoundary(engine, m, owner, sql);
        } catch (error) {
          throw withLocations(error, m.statementUses.get(key)!, sql);
        }
        for (const b of analysis.brands) used.add(b);
        if (analysis.scans.length > 0) scans.push({ module: m.name, sql: key, tables: analysis.scans });
        entries.push({ key, analysis });
      }
      const typeMs = performance.now() - typeStarted;
      if (m.readsAll) {
        const analysisBySql = new Map(entries.map((entry) => [entry.key, entry.analysis]));
        for (const query of m.queries) reads.push({ module: m.name, query: query.name, tables: analysisBySql.get(query.sql)!.reads });
      }
      checkCommands(m, entries);
      if (options.inspect) {
        for (const { key, analysis } of entries) {
          operations.push({ module: m.name, sql: key, locations: m.statementUses.get(key)!, params: analysis.params,
            columns: analysis.columns, origins: engine.columns(analysis.sql), accesses: engine.accesses(analysis.sql), reads: analysis.reads });
        }
      }
      const importedBrands = new Map<string, string[]>();
      for (const b of used) {
        const from = brandModule.get(b);
        if (!from || from === m.name) continue;
        const dir = modules.find((x) => x.name === from)!.dir;
        let specifier = relative(m.dir, join(dir, GENERATED_FILE)).split("\\").join("/");
        if (!specifier.startsWith(".")) specifier = `./${specifier}`;
        importedBrands.set(specifier, [...(importedBrands.get(specifier) ?? []), b]);
      }
      const text = emitGenerated({
        library,
        module: m.name,
        ownBrands: [...brands.values()].filter((b) => b.module === m.name).sort((a, b) => a.table.localeCompare(b.table)),
        importedBrands: [...importedBrands].map(([specifier, names]) => ({ specifier, names })),
        entries,
      });
      const generatedPath = join(m.dir, GENERATED_FILE);
      // The keys of the file as it is now come from importing it: load()
      // wrote a stub when it was missing, so the import always succeeds.
      const before = Object.keys(((await importFresh(generatedPath)) as { generated?: Record<string, unknown> }).generated ?? {});
      const { added, removed } = keyDiff(before, entries.map((e) => e.key));
      const changed = readFileSync(generatedPath, "utf8") !== text;
      if (changed && write) writeGeneratedFile(generatedPath, text);
      results.push({ name: m.name, generatedPath, entries: entries.length, changed, added, removed, ms: Math.round(m.importMs + typeMs) });
    }

    const migration = migrationStatus(configDir, config, modules);
    const index = await migrationsIndex(resolve(configDir, config.migrations), write);
    const inspection = options.inspect ? { sqlite: String(engine.db.prepare("select sqlite_version() as version").get()!.version), operations } : undefined;
    return { modules: results, migration, index, scans, reads, ms: Math.round(performance.now() - buildStarted), ...(inspection ? { inspection } : {}) };
  } finally {
    engine.close();
  }
}

// A module imports another module through its public.ts only (ADR 0008).
// The check reads the import and export specifiers of the module's own
// files. The generated file is the build's, and it imports the id types of
// other modules from their generated files by design (ADR 0025).
function checkImports(modules: readonly Module[]): void {
  for (const m of modules) {
    for (const file of readdirSync(m.dir).filter((f) => f.endsWith(".ts") && f !== GENERATED_FILE).sort()) {
      const text = readFileSync(join(m.dir, file), "utf8");
      for (const match of text.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue;
        const target = resolve(m.dir, specifier);
        const other = modules.find((o) => o !== m && (target === o.dir || target.startsWith(o.dir + sep)));
        if (other && basename(target) !== "public.ts") {
          throw new BuildError(`module ${m.name}: ${file} imports ${specifier}. Module ${other.name} shows public.ts; import from there.`);
        }
      }
    }
  }
}

// A module may touch its own tables, the primary key of a table its foreign
// keys reference, the foreign key columns of tables that reference its own
// (a delete from a parent table reads them), the guard table, and
// everything when it reads all.
// Tables outside the declared schema (json_each, pragma_*) are not checked.
// `subject` names what is checked when it is not the statement itself: a
// view, read whole, or a trigger body, seen through a statement that fires
// it. `via` keeps the accesses of one trigger only.
function checkBoundary(engine: Engine, m: Module, owner: Map<string, Module>, sql: string, subject?: string, via?: string): void {
  for (const a of engine.accesses(sql)) {
    if (a.action === "function" || a.action === "other" || !a.table) continue;
    if (via !== undefined && a.via !== via) continue;
    const table = a.table;
    const o = owner.get(table);
    if (!o || table === GUARD_TABLE || o === m) continue;
    if (a.action === "read" && m.readsAll) continue;
    if (a.action === "read" && a.column && (isReferencedKey(engine, m, table, a.column) || isReferencingKey(engine, m, owner, table, a.column))) continue;
    const what = a.action === "read" ? `reads ${table}.${a.column}` : a.action === "insert" ? `inserts into ${table}` : a.action === "update" ? `updates ${table}` : `deletes from ${table}`;
    const who = subject ? `module ${m.name}: ${subject}` : `module ${m.name}`;
    throw new BuildError(`${who} ${what}. Module ${o.name} owns ${table}. Use its public.ts, or declare readsAll for a report module.`, subject ? undefined : sql);
  }
}

// The engine compiles a trigger body with the statement that fires it, and
// the authorizer reports the body's accesses with the trigger's name. So a
// statement of the trigger's event is prepared, and the accesses it
// reports through the trigger are checked. An `update of c1, c2` trigger
// is compiled only when the statement sets one of those columns, so the
// statement sets the first of them.
function checkTriggerBoundary(engine: Engine, m: Module, owner: Map<string, Module>, sql: string): void {
  const t = triggerTarget(sql)!;
  const table = quoteIdent(t.table);
  const column = t.columns[0] ?? engine.firstSettableColumn(t.table);
  if (column === null) throw new BuildError(`module ${m.name}: trigger ${t.name}: ${t.table} has no column to set`, sql);
  const set = quoteIdent(column);
  const firing = t.event === "insert" ? `insert into ${table} default values` : t.event === "delete" ? `delete from ${table}` : `update ${table} set ${set} = ${set}`;
  // The engine checks a trigger body when it compiles the body into a
  // statement, not at CREATE TRIGGER, so its message arrives here.
  // checkBoundary below reads this same compile's table accesses through
  // engine.accesses(), a permissive authorizer that never denies a
  // function; engine.prepare() first, with the deny authorizer, is what
  // catches a trigger body's own disallowed function call. Without it, an
  // orphan trigger (no plan item fires it) would never be prepared with a
  // deny authorizer at all (ADR 0114).
  try {
    engine.prepare(firing);
    checkBoundary(engine, m, owner, firing, `trigger ${t.name}`, t.name);
  } catch (e) {
    if (e instanceof BuildError) throw e;
    throw new BuildError(`module ${m.name}: trigger ${t.name}: ${(e as Error).message}`, sql);
  }
}

function isReferencedKey(engine: Engine, m: Module, table: string, column: string): boolean {
  for (const sql of m.tables) {
    const c = created(sql)!;
    const t = engine.table(c.name);
    if (t.foreignKeys.some((f) => f.table === table && f.to === column)) return true;
  }
  return false;
}

// The engine checks a delete from, or an update of the key of, a parent
// table by reading the foreign key columns of every child, in whichever
// module the child lives.
function isReferencingKey(engine: Engine, m: Module, owner: Map<string, Module>, table: string, column: string): boolean {
  return engine.table(table).foreignKeys.some((f) => f.from === column && owner.get(f.table) === m);
}

// Rules a plan must follow: one type per parameter name across the plan,
// and changes() only right after the statement it measures. A parameter
// the build could not place in one statement (SqlValue) takes the type,
// and the JSON encoding, of its typed use elsewhere in the plan, so the
// command's parameter object has one type and every statement binds the
// value the same way.
function checkCommands(m: Module, entries: readonly { key: string; analysis: Analysis }[]): void {
  const byKey = new Map(entries.map((e) => [e.key, e.analysis]));
  // Where a statement's parameter was refined, so two commands that share
  // the statement cannot pull it two ways.
  const refined = new Map<string, Map<string, { type: string; command: string }>>();
  for (const c of m.commands) {
    let failureKeys: string[] = [];
    try {
      const types = new Map<string, { type: string; encode: boolean; sql: string }>();
      const keys = [...c.plan.map((i) => (typeof i === "string" ? i : i.predicate)), ...(c.returns ? [c.returns] : [])];
      for (const key of keys) {
        for (const p of byKey.get(key)!.params) {
          const seen = types.get(p.name);
          if (seen && p.type === "SqlValue") continue;
          if (seen && seen.type === "SqlValue") {
            types.set(p.name, { type: p.type, encode: p.encode, sql: key });
            continue;
          }
          if (seen && seen.type !== p.type) {
            failureKeys = [seen.sql, key];
            throw new BuildError(
              `command ${m.name}.${c.name}: parameter ${JSON.stringify(p.name)} is ${seen.type} in one statement and ${p.type} in another.\n  ${seen.sql}\n  ${key}`,
            );
          }
          types.set(p.name, { type: p.type, encode: p.encode, sql: key });
        }
      }
      for (const key of keys) {
        for (const p of byKey.get(key)!.params) {
          const t = types.get(p.name)!;
          if (p.type !== "SqlValue" || t.type === "SqlValue") continue;
          const earlier = refined.get(key)?.get(p.name);
          if (earlier && earlier.type !== t.type) {
            failureKeys = [key, t.sql];
            throw new BuildError(`parameter ${JSON.stringify(p.name)} of this statement is ${earlier.type} in command ${m.name}.${earlier.command} and ${t.type} in command ${m.name}.${c.name}. Give the statement a type of its own, or split it.`, key);
          }
          p.type = t.type;
          p.encode = t.encode;
          refined.set(key, new Map([...(refined.get(key) ?? []), [p.name, { type: t.type, command: c.name }]]));
        }
      }
      for (const [i, item] of c.plan.entries()) {
        if (typeof item === "string") continue;
        const previous = c.plan[i - 1];
        if (/\bchanges\s*\(/i.test(item.predicate) && (previous === undefined || typeof previous !== "string")) {
          failureKeys = [item.predicate];
          throw new BuildError(`command ${m.name}.${c.name}: assert ${item.name} uses changes(), which counts the statement right before it. Put it right after that statement.`);
        }
      }
      if (c.returns && /\bchanges\s*\(/i.test(c.returns)) {
        failureKeys = [c.returns];
        throw new BuildError(`command ${m.name}.${c.name}: the returns clause uses changes(), which counts the plan's last statement. Read the command's changes result instead.`);
      }
    } catch (error) {
      const locations = new Set([
        `${join(m.dir, "module.ts")}: command ${c.catalog}.${c.name}`,
        ...failureKeys.flatMap((key) => m.statementUses.get(key) ?? []),
      ]);
      throw withLocations(error, [...locations]);
    }
  }
}

// Keep the engine's message and SQL intact; catalog identity comes from the
// imported exports, which also covers dynamically constructed catalogs.
function withLocations(error: unknown, locations: readonly string[], sql?: string): BuildError {
  const diagnostic = error instanceof BuildError ? error : new BuildError(error instanceof Error ? error.message : String(error), sql);
  diagnostic.message += `\n  at: ${locations.join("\n  at: ")}`;
  diagnostic.locations.push(...locations);
  return diagnostic;
}

function migrationFiles(dir: string): { name: string; sql: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

// index.ts follows the .sql files. The migration command writes both; a
// file edited by hand, or merged, would leave the Durable Object with other
// SQL than D1 gets, so the build keeps the two in step. A concurrent
// `solarsql migration` can add a file between this function's first read
// and its own write; the same lock migration() already holds for that
// write (ADR 0060) is reacquired here, and the read is repeated once
// inside it, so a build that raced a migration writes the migration's own
// result, not a snapshot from before it ran.
async function migrationsIndex(dir: string, write: boolean): Promise<BuildResult["index"]> {
  const files = migrationFiles(dir);
  if (files.length === 0) return { path: null, changed: false };
  const path = join(dir, "index.ts");
  const wanted = emitMigrationsIndex(files);
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== wanted;
  if (!changed || !write) return { path, changed };
  return await withMigrationLock(dir, () => {
    const currentFiles = migrationFiles(dir);
    const currentWanted = emitMigrationsIndex(currentFiles);
    const stillChanged = !existsSync(path) || readFileSync(path, "utf8") !== currentWanted;
    if (stillChanged) writeGeneratedFile(path, currentWanted);
    return { path, changed: stillChanged };
  });
}

const emptyIntent: MigrationIntent = { drops: [], renames: [] };

function migrationStatus(configDir: string, config: Config, modules: readonly Module[], intent: MigrationIntent = emptyIntent): BuildResult["migration"] {
  const dir = resolve(configDir, config.migrations);
  const files = migrationFiles(dir);
  migrationSequence(files.map((f) => f.name));
  const current = applied(files.map((f) => f.sql), files.map((f) => f.name));
  const target = open(declaredDdl(modules));
  try {
    const plan = diff(introspect(current), introspect(target), intent.renames, intent.drops);
    if (plan.kind === "blocked") return { pending: true, statements: [], reason: plan.reason, ...(plan.drops ? { drops: plan.drops } : {}), ...(plan.renames ? { renames: plan.renames } : {}), ...(plan.renameCandidates ? { renameCandidates: plan.renameCandidates } : {}) };
    return { pending: plan.statements.length > 0, statements: plan.statements, reason: null, ...(plan.rebuilds ? { rebuilds: plan.rebuilds } : {}) };
  } finally {
    current.close();
    target.close();
  }
}

// Write the next migration file, and the bundle a Durable Object imports.
export async function migration(configPath: string, name: string, intent: MigrationIntent = emptyIntent): Promise<{ filename: string | null; reason: string | null; drops?: DropIntent[]; renames?: Rename[]; renameCandidates?: RenameRepair[] }> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new BuildError(`migration name must match [a-z0-9_]+: ${name}`);
  // build() enforces the module boundary, STRICT/primary-key, foreign-key
  // target, and command-plan rules before this function ever touches the
  // migrations directory. Loading the configuration once and running
  // build's own check body on that one load, write: false, means a
  // schema or command change that would fail build() also fails
  // migration() before a file exists, instead of only surfacing on a
  // later, separate build --check (ADR 0096). A second full import would
  // run the configuration's own import-time side effects twice.
  const loaded = await load(configPath);
  await buildLoaded(loaded, { write: false });
  const { config, configDir, modules } = loaded;
  const dir = resolve(configDir, config.migrations);
  mkdirSync(dir, { recursive: true });
  return await withMigrationLock(dir, () => {
    const files = migrationFiles(dir);
    migrationSequence(files.map(file => file.name));
    const status = migrationStatus(configDir, config, modules, intent);
    if (status.reason) return { filename: null, reason: status.reason, ...(status.drops ? { drops: status.drops } : {}), ...(status.renames ? { renames: status.renames } : {}), ...(status.renameCandidates ? { renameCandidates: status.renameCandidates } : {}) };
    let filename: string | null = null;
    if (status.pending) {
      const file = nextMigrationFile(files.map(file => file.name), name, status.statements, status.rebuilds ?? []);
      writeNewMigration(dir, file);
      filename = file.filename;
    }
    writeGeneratedFile(join(dir, "index.ts"), emitMigrationsIndex(migrationFiles(dir)));
    return { filename, reason: null };
  });
}
