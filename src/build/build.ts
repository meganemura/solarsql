// Responsibility: `solarsql build` and `solarsql migration`. Read the
// configuration, import every module, type every statement with the
// engine, check the module boundaries, write the generated files, and
// compare the migration files with the declared schema.
// Boundary: this file owns the module layout and the file system. The
// facts come from facts.ts, the types from typegen.ts, the file text from
// emit.ts, and the migration statements from migration.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command, Config, Index, ModuleConfig, PlanItem, Query, Table, Trigger, View } from "../index.ts";
import { GUARD_DDL, GUARD_TABLE, assertStatement } from "../runtime/plan.ts";
import { GENERATED_FILE, emitGenerated, emitMigrationsIndex, emitStub } from "./emit.ts";
import { Engine } from "./facts.ts";
import { applied, diff, introspect, open, render } from "./migration.ts";
import { created, quoteIdent, triggerTarget } from "./scan.ts";
import { BuildError, Typer, brandName, type Analysis, type Brand } from "./typegen.ts";

export type Module = {
  name: string;
  dir: string;
  readsAll: boolean;
  tables: string[];
  indexes: string[];
  views: string[];
  triggers: string[];
  // Every statement the module runs, keyed by what the generated map keys it
  // on: the SQL of a query or statement, or the predicate of an assert.
  statements: Map<string, string>;
  commands: { name: string; plan: readonly PlanItem[]; returns: string | null }[];
};

export type BuildResult = {
  // Per module: the statements this build added to and removed from the
  // generated file, so the CLI can say what changed.
  modules: { name: string; generatedPath: string; entries: number; changed: boolean; added: string[]; removed: string[] }[];
  migration: { pending: boolean; statements: string[]; reason: string | null };
  // Statements whose plan scans a table in full despite a WHERE clause.
  scans: { module: string; sql: string; tables: string[] }[];
};

export type Loaded = { config: Config; configDir: string; modules: Module[] };

// The module files, imported. The generated file gets a stub first, so the
// import succeeds before the first build.
export async function load(configPath: string): Promise<Loaded> {
  const absolute = resolve(configPath);
  const configDir = dirname(absolute);
  const config = (await importFresh(absolute)).default as Config | undefined;
  if (!config || !Array.isArray(config.modules) || typeof config.migrations !== "string") {
    throw new BuildError(`${configPath} must export default config({ modules: [...], migrations: "..." })`);
  }
  const modules: Module[] = [];
  for (const entry of config.modules) {
    const mc: ModuleConfig = typeof entry === "string" ? { dir: entry } : entry;
    const dir = resolve(configDir, mc.dir);
    const name = basename(dir);
    if (!existsSync(join(dir, "schema.ts"))) throw new BuildError(`module ${name}: ${join(dir, "schema.ts")} does not exist`);
    const generatedPath = join(dir, GENERATED_FILE);
    if (!existsSync(generatedPath)) writeFileSync(generatedPath, emitStub(config.library ?? "solarsql"));
    const schema = await importFresh(join(dir, "schema.ts"));
    const tables: string[] = [];
    const indexes: string[] = [];
    const views: string[] = [];
    const triggers: string[] = [];
    for (const value of Object.values(schema)) {
      const v = value as Table | Index | View | Trigger;
      if (!v || typeof v !== "object") continue;
      if (v.kind === "table") tables.push(v.sql);
      if (v.kind === "index") indexes.push(v.sql);
      if (v.kind === "view") views.push(v.sql);
      if (v.kind === "trigger") triggers.push(v.sql);
    }
    const statements = new Map<string, string>();
    const commands: Module["commands"] = [];
    if (existsSync(join(dir, "queries.ts"))) {
      const queries = await importFresh(join(dir, "queries.ts"));
      for (const value of Object.values(queries)) {
        const v = value as { kind?: string; entries?: Record<string, Query<string, never>> };
        if (v && typeof v === "object" && v.kind === "queries" && v.entries) {
          for (const q of Object.values(v.entries)) statements.set(q.sql, q.sql);
        }
      }
    }
    if (existsSync(join(dir, "commands.ts"))) {
      const cmds = await importFresh(join(dir, "commands.ts"));
      for (const value of Object.values(cmds)) {
        const v = value as { kind?: string; entries?: Record<string, Command<never, never>> };
        if (v && typeof v === "object" && v.kind === "commands" && v.entries) {
          for (const [cname, c] of Object.entries(v.entries)) {
            commands.push({ name: cname, plan: c.plan, returns: c.returns });
            for (const item of c.plan) {
              if (typeof item === "string") statements.set(item, item);
              else statements.set(item.predicate, assertStatement(item.name, item.predicate));
            }
            if (c.returns !== null) statements.set(c.returns, c.returns);
          }
        }
      }
    }
    modules.push({ name, dir, readsAll: mc.readsAll ?? false, tables, indexes, views, triggers, statements, commands });
  }
  return { config, configDir, modules };
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
// Tables first, then indexes, views, and triggers, since a view reads
// tables and a trigger body may read a view.
export function declaredDdl(modules: readonly Module[]): string[] {
  return [...modules.flatMap((m) => m.tables), ...modules.flatMap((m) => m.indexes), ...modules.flatMap((m) => m.views), ...modules.flatMap((m) => m.triggers), ...GUARD_DDL];
}

export async function build(configPath: string): Promise<BuildResult> {
  const loaded = await load(configPath);
  const { config, configDir, modules } = loaded;
  const library = config.library ?? "solarsql";

  // Ownership: one module per table.
  const owner = new Map<string, Module>();
  for (const m of modules) {
    for (const sql of m.tables) {
      const c = created(sql);
      if (!c || c.kind !== "table") throw new BuildError(`module ${m.name}: table() needs one CREATE TABLE statement`, sql);
      const other = owner.get(c.name);
      if (other) throw new BuildError(`table ${c.name} is declared by module ${other.name} and by module ${m.name}`);
      owner.set(c.name, m);
    }
    for (const sql of m.indexes) {
      const c = created(sql);
      if (!c || c.kind !== "index") throw new BuildError(`module ${m.name}: index() needs one CREATE INDEX statement`, sql);
    }
    for (const sql of m.views) {
      const c = created(sql);
      if (!c || c.kind !== "view") throw new BuildError(`module ${m.name}: view() needs one CREATE VIEW statement`, sql);
    }
  }
  // A trigger sits on a table of its own module.
  for (const m of modules) {
    for (const sql of m.triggers) {
      const t = triggerTarget(sql);
      if (!t) throw new BuildError(`module ${m.name}: trigger() needs one CREATE TRIGGER statement with BEFORE, AFTER, or INSTEAD OF, an event, and ON <table>`, sql);
      const o = owner.get(t.table);
      if (o !== m) throw new BuildError(`module ${m.name}: trigger ${t.name} is on table ${t.table}, which ${o ? `module ${o.name} owns` : "no module declares"}. A trigger belongs to the module of its table.`, sql);
    }
  }

  const engine = new Engine(declaredDdl(modules));
  try {
    const brands = new Map<string, Brand>();
    for (const t of engine.tables()) {
      const pk = t.columns.filter((c) => c.pk > 0);
      const m = owner.get(t.name);
      if (!m) continue;
      if (pk.length === 0) throw new BuildError(`table ${t.name} has no primary key. Declare one: id text primary key not null.`);
      // A STRICT table makes its primary key NOT NULL by itself, so the id
      // brand is never nullable (ADR 0018, ADR 0029).
      if (!t.strict) {
        throw new BuildError(`table ${t.name} is not STRICT. Add \`strict\` after the closing parenthesis, so the engine rejects a value that does not match the declared type.`);
      }
      if (pk.length === 1) brands.set(t.name, { table: t.name, column: pk[0]!.name, typeName: brandName(t.name), module: m.name });
    }
    for (const m of modules) {
      for (const sql of m.views) checkBoundary(engine, m, owner, `select * from ${quoteIdent(created(sql)!.name)}`, `view ${created(sql)!.name}`);
      for (const sql of m.triggers) checkTriggerBoundary(engine, m, owner, sql);
    }
    const typer = new Typer(engine, brands);
    const brandModule = new Map([...brands.values()].map((b) => [b.typeName, b.module]));
    const results: BuildResult["modules"] = [];
    const scans: BuildResult["scans"] = [];

    for (const m of modules) {
      const entries: { key: string; analysis: Analysis }[] = [];
      const used = new Set<string>();
      for (const [key, sql] of m.statements) {
        const analysis = typer.analyze(sql, m.name);
        checkBoundary(engine, m, owner, sql);
        for (const b of analysis.brands) used.add(b);
        if (analysis.scans.length > 0) scans.push({ module: m.name, sql: key, tables: analysis.scans });
        entries.push({ key, analysis });
      }
      checkCommands(m, entries);
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
      if (changed) writeFileSync(generatedPath, text);
      results.push({ name: m.name, generatedPath, entries: entries.length, changed, added, removed });
    }

    const migration = migrationStatus(configDir, config, modules);
    return { modules: results, migration, scans };
  } finally {
    engine.close();
  }
}

// A module may touch its own tables, the primary key of a table its foreign
// keys reference, the guard table, and everything when it reads all.
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
    if (a.action === "read" && a.column && isReferencedKey(engine, m, table, a.column)) continue;
    const what = a.action === "read" ? `reads ${table}.${a.column}` : `${a.action}s into ${table}`;
    const who = subject ? `module ${m.name}: ${subject}` : `module ${m.name}`;
    throw new BuildError(`${who} ${what}. Module ${o.name} owns ${table}. Use its public.ts, or declare readsAll for a report module.`, subject ? undefined : sql);
  }
}

// The engine compiles a trigger body with the statement that fires it, and
// the authorizer reports the body's accesses with the trigger's name. So a
// statement of the trigger's event is prepared, and the accesses it
// reports through the trigger are checked.
function checkTriggerBoundary(engine: Engine, m: Module, owner: Map<string, Module>, sql: string): void {
  const t = triggerTarget(sql)!;
  const table = quoteIdent(t.table);
  const first = quoteIdent(engine.table(t.table).columns[0]!.name);
  const firing = t.event === "insert" ? `insert into ${table} default values` : t.event === "delete" ? `delete from ${table}` : `update ${table} set ${first} = ${first}`;
  checkBoundary(engine, m, owner, firing, `trigger ${t.name}`, t.name);
}

function isReferencedKey(engine: Engine, m: Module, table: string, column: string): boolean {
  for (const sql of m.tables) {
    const c = created(sql)!;
    const t = engine.table(c.name);
    if (t.foreignKeys.some((f) => f.table === table && f.to === column)) return true;
  }
  return false;
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
          throw new BuildError(
            `command ${m.name}.${c.name}: parameter :${p.name} is ${seen.type} in one statement and ${p.type} in another.\n  ${seen.sql}\n  ${key}`,
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
          throw new BuildError(`parameter :${p.name} of this statement is ${earlier.type} in command ${m.name}.${earlier.command} and ${t.type} in command ${m.name}.${c.name}. Give the statement a type of its own, or split it.`, key);
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
        throw new BuildError(`command ${m.name}.${c.name}: assert ${item.name} uses changes(), which counts the statement right before it. Put it right after that statement.`);
      }
    }
  }
}

function migrationFiles(dir: string): { name: string; sql: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

function migrationStatus(configDir: string, config: Config, modules: readonly Module[]): BuildResult["migration"] {
  const dir = resolve(configDir, config.migrations);
  const files = migrationFiles(dir);
  const current = applied(files.map((f) => f.sql));
  const target = open(declaredDdl(modules));
  try {
    const plan = diff(introspect(current), introspect(target));
    if (plan.kind === "blocked") return { pending: true, statements: [], reason: plan.reason };
    return { pending: plan.statements.length > 0, statements: plan.statements, reason: null };
  } finally {
    current.close();
    target.close();
  }
}

// Write the next migration file, and the bundle a Durable Object imports.
export async function migration(configPath: string, name: string): Promise<{ filename: string | null; reason: string | null }> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new BuildError(`migration name must match [a-z0-9_]+: ${name}`);
  const { config, configDir, modules } = await load(configPath);
  const status = migrationStatus(configDir, config, modules);
  if (status.reason) return { filename: null, reason: status.reason };
  const dir = resolve(configDir, config.migrations);
  mkdirSync(dir, { recursive: true });
  let filename: string | null = null;
  if (status.pending) {
    const files = migrationFiles(dir);
    const next = files.length + 1;
    const file = render(next, name, status.statements);
    writeFileSync(join(dir, file.filename), file.sql);
    filename = file.filename;
  }
  writeFileSync(join(dir, "index.ts"), emitMigrationsIndex(migrationFiles(dir)));
  return { filename, reason: null };
}
