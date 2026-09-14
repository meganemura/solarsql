// Responsibility: turn one SQL statement into its entry of the generated
// map: the parameters it takes, the row it returns, and the columns that
// hold JSON. Every type comes from the engine (facts.ts) and from the
// fixed text shapes of scan.ts. This file emits TypeScript type text.
// Boundary: no file system, no module layout, no boundary check. build.ts
// owns those. A shape this file cannot type becomes a BuildError with the
// SQL and the reason.
import { queryScope, querySources, sqliteName, unionType, unionMembers, type Cte } from "./scope.ts";
import { GUARD_TABLE } from "../runtime/plan.ts";
import type { ColumnFact, Engine, OutputColumn, TableFact } from "./facts.ts";
import { aliasMap, columnRef, findCall, isKeyword, leadingComment, namedParams, nonNullFilterAlias, paramSites, quoteIdent, returningClause, selectItems, significant, splitAtCommas, tokenize, unquote } from "./scan.ts";

export class BuildError extends Error {
  readonly sql: string | undefined;
  readonly locations: string[] = [];
  // A short next step for a JSON diagnostic consumer (build --json's own
  // "action" field); undefined when the message has no single next step.
  readonly action: string | undefined;
  constructor(message: string, sql?: string, action?: string) {
    super(sql === undefined ? message : `${message}\n  in: ${sql.replace(/\s+/g, " ").trim()}`);
    this.name = "BuildError";
    this.sql = sql;
    this.action = action;
  }
}

// Where the id type of each table lives, so the generated file of one module
// can import the ids of the tables its foreign keys reference.
export type Brand = { table: string; column: string; typeName: string; module: string };

export type Analysis = {
  sql: string;
  doc: string;
  // A query returns rows. A statement of a plan returns nothing.
  returnsRows: boolean;
  // `encode` marks a parameter the adapter turns into JSON text: an array
  // for json_each.
  params: { name: string; type: string; encode: boolean }[];
  columns: { name: string; type: string; json: boolean }[];
  // Brands this entry uses, for the imports of the generated file.
  brands: Set<string>;
  // Tables the engine scans in full for a statement with a WHERE clause.
  scans: string[];
  // The tables of the schema the statement reads, sorted, once each: reached
  // directly, through a view, through a trigger the statement fires, or by
  // a foreign key check. A view, json_each, and pragma_* are not tables.
  reads: string[];
};

export function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}

export function brandName(table: string): string {
  return `${pascal(table)}Id`;
}

export function scalarType(declared: string): string {
  const t = declared.toUpperCase();
  // ANY is the STRICT column that holds any storage class.
  if (t === "ANY") return "SqlValue";
  if (t.includes("INT")) return "number";
  if (t.includes("CHAR") || t.includes("TEXT") || t.includes("CLOB")) return "string";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUM") || t.includes("DEC")) return "number";
  if (t.includes("BLOB")) return "Uint8Array";
  if (t.includes("BOOL")) return "number";
  return "unknown";
}

function affinityType(affinity: string): string | null {
  const a = affinity.toUpperCase();
  if (a === "") return null;
  return scalarType(a);
}

type ScopeColumn = Analysis["columns"][number] & { hidden?: boolean };
type Binding = Cte & { environment: Map<string, Binding> };
type ScopeContext = { rows: Map<string, ScopeColumn[]>; visible: ScopeColumn[]; nullable: Set<string>; environment: Map<string, Binding>; active: Set<Binding | string>; parent?: ScopeContext };

type Resolved = { type: string; nullable: boolean; brand: string | null };

function jsonResultType(input: string): string {
  // A BLOB can contain JSONB. Flexible storage can also hold that BLOB,
  // so a successful JSON constructor can return an object or array here.
  return unionMembers(input).some(type => type === "Uint8Array" || type === "SqlValue") ? "JsonValue" : input;
}

const rowIdentifiers = ["rowid", "_rowid_", "oid"];

function implicitRowIdentifier(table: TableFact, name: string): boolean {
  return !table.withoutRowid && rowIdentifiers.includes(sqliteName(name))
    && !table.columns.some(column => sqliteName(column.name) === sqliteName(name));
}

export class Typer {
  private readonly recursiveRows = new Map<Binding, ScopeColumn[]>();
  private readonly tables = new Map<string, TableFact>();
  private readonly engine: Engine;
  private readonly brands: Map<string, Brand>;

  private readonly conservativeStorage: boolean;

  constructor(engine: Engine, brands: Map<string, Brand>, options: { conservativeStorage?: boolean } = {}) {
    this.engine = engine;
    this.brands = brands;
    this.conservativeStorage = options.conservativeStorage ?? false;
    for (const t of engine.tables()) this.tables.set(t.name, t);
  }

  // The base type of one table column, before nullability from a join.
  column(table: string, column: string, sql: string): Resolved {
    const t = this.tables.get(table);
    const c = t?.columns.find((x) => sqliteName(x.name) === sqliteName(column));
    // SQLite stores an implicit row identifier as an integer even on a
    // non-STRICT table. A declared column takes precedence over that spelling.
    if (t && implicitRowIdentifier(t, column)) return { type: "number", nullable: false, brand: null };
    if (!t || !c) throw new BuildError(`unknown column ${table}.${column}`, sql);
    // An existing non-STRICT table can store a class outside its affinity.
    // CHECK literals alone do not prove the class after SQLite conversion.
    if (this.conservativeStorage) {
      return { type: t.strict ? scalarType(c.type) : "SqlValue", nullable: !c.notnull, brand: null };
    }
    // A full-text search table: its columns hold text and may be null, its
    // rank can be null without MATCH, and the column named after the table is the match
    // target, which takes the query string.
    if (t.virtual) {
      if (c.name === "rank") return { type: "number", nullable: true, brand: null };
      if (c.name === t.name) return { type: "string", nullable: false, brand: null };
      return { type: "string", nullable: true, brand: null };
    }
    const brand = this.brandOf(t, c);
    if (brand) return { type: brand.typeName, nullable: !c.notnull, brand: brand.typeName };
    const scalar = scalarType(c.type);
    // Affinity converts comparison operands and stored values. A textual list
    // on an integer column does not establish a union of string results.
    if (c.oneOf && ((scalar === "string" && c.oneOf.every(v => typeof v === "string"))
      || (scalar === "number" && c.oneOf.every(v => typeof v === "number"))
      || (scalar === "SqlValue" && t.strict))) {
      return { type: c.oneOf.map(v => JSON.stringify(v)).join(" | "), nullable: !c.notnull, brand: null };
    }
    if (scalar === "unknown") throw new BuildError(`column ${table}.${column} has the declared type "${c.type}", which maps to no TypeScript type. Use text, integer, real, or blob.`, sql);
    return { type: scalar, nullable: !c.notnull, brand: null };
  }

  private brandOf(t: TableFact, c: ColumnFact): Brand | null {
    // SQLite compares foreign keys using the parent's affinity. The child
    // can still store a different class, so a reference alone proves no brand.
    if (scalarType(c.type) !== "string") return null;
    const own = this.brands.get(t.name);
    if (own && own.column === c.name) return own;
    const fk = t.foreignKeys.find((f) => f.from === c.name);
    if (fk) {
      const target = this.brands.get(fk.table);
      if (target && target.column === fk.to) return target;
    }
    return null;
  }

  analyze(sql: string, module: string): Analysis {
    const brands = new Set<string>();
    const note = (r: Resolved) => {
      if (r.brand) brands.add(r.brand);
      return r;
    };
    const { names, anonymous } = namedParams(sql);
    if (anonymous.length > 0) throw new BuildError(`use a named parameter (:name) instead of "${anonymous[0]!.text}"`, sql);
    // Preparing first turns a syntax error or an unknown name into the
    // engine's own message.
    try {
      this.engine.prepare(sql);
    } catch (e) {
      throw new BuildError((e as Error).message, sql);
    }
    const aliases = aliasMap(sql);
    const select = isSelect(sql);
    const outputs = this.engine.columns(sql);
    const returnsRows = outputs.length > 0;
    this.distinctOutputs(outputs, sql);
    const columns = select ? this.scopeRows(sql, new Map(), new Set(), note) : this.returningColumns(sql, outputs, aliases, note);
    const params = names.map((name) => ({ name, ...this.paramType(sql, name, aliases, note) }));
    const scans = select && /\bwhere\b/i.test(sql) ? this.engine.fullScans(sql) : [];
    const usedTypes = [...columns.map((column) => column.type), ...params.map((param) => param.type)].join(" ").replace(/"(?:[^"\\]|\\.)*"/g, "");
    for (const brand of brands) if (!new RegExp(`\\b${brand}\\b`).test(usedTypes)) brands.delete(brand);
    return { sql, doc: leadingComment(sql), returnsRows, params, columns, brands, scans, reads: this.reads(sql) };
  }

  // The authorizer reports every read at prepare, under the table's name,
  // and names a view, a table-valued function, and the guard table the
  // same way; the declared tables are the ones that hold rows.
  private reads(sql: string): string[] {
    const out = new Set<string>();
    for (const a of this.engine.accesses(sql)) {
      if (a.action === "read" && a.table !== null && a.table !== GUARD_TABLE && this.tables.has(a.table)) out.add(a.table);
    }
    return [...out].sort();
  }

  private distinctOutputs(outputs: readonly { name: string }[], sql: string): void {
    const names = new Set<string>();
    for (const out of outputs) {
      if (names.has(out.name)) throw new BuildError(`duplicate output column "${out.name}". Give each output a distinct AS name.`, sql);
      names.add(out.name);
    }
  }

  private scopeProbe(sql: string, environment: Map<string, Binding>): string {
    if (environment.size === 0) return sql;
    const bindings = [...environment.values()].map((binding) => `${quoteIdent(binding.name)}${binding.columns.length ? `(${binding.columns.map(quoteIdent).join(",")})` : ""} as (${binding.sql})`);
    return `with ${bindings.join(", ")} ${sql}`;
  }

  private nullableColumn(column: ScopeColumn): ScopeColumn {
    return { ...column, type: unionType(column.type, "null") };
  }

  private mergeColumn(left: ScopeColumn, right: ScopeColumn, sql: string): ScopeColumn {
    if (left.json !== right.json && left.type !== "null" && right.type !== "null") {
      throw new BuildError(`column "${left.name}" mixes decoded JSON and SQL scalar values. CAST the JSON branch AS TEXT to return text in every branch.`, sql);
    }
    return { name: left.name, type: unionType(left.type, right.type), json: left.json || right.json };
  }

  private scopeRows(sql: string, inherited: Map<string, Binding>, active: Set<Binding | string>, note: (r: Resolved) => Resolved, parent?: ScopeContext): ScopeColumn[] {
    let scope: ReturnType<typeof queryScope>;
    try { scope = queryScope(sql); } catch (error) { throw new BuildError(`query scope: ${(error as Error).message}`, sql); }
    const environment = new Map(inherited);
    for (const cte of scope.ctes) environment.set(sqliteName(cte.name), { ...cte, environment });
    const rows = scope.branches.map((branch) => this.branchRows(branch, environment, active, note, parent));
    let result = rows[0]!;
    for (let i = 1; i < rows.length; i++) {
      // INTERSECT and EXCEPT return values of the left input. UNION can
      // return either branch, so both the storage type and JSON policy merge.
      if (scope.operators[i - 1]!.startsWith("union")) result = result.map((column, j) => this.mergeColumn(column, rows[i]![j]!, sql));
    }
    return result;
  }

  private sourceRows(source: ReturnType<typeof querySources>[number], environment: Map<string, Binding>, active: Set<Binding | string>, note: (r: Resolved) => Resolved): ScopeColumn[] {
    if (source.query) return this.scopeRows(source.query, environment, active, note);
    if (source.functionSql) {
      return this.engine.columns(this.scopeProbe(`select * from ${source.functionSql}`, environment)).map((column) => ({ name: column.name, type: "SqlValue", json: false }));
    }
    const name = source.name!;
    const binding = source.schema === null ? environment.get(sqliteName(name)) : undefined;
    if (binding) {
      if (active.has(binding)) {
        const rows = this.recursiveRows.get(binding);
        if (rows) return rows;
        throw new BuildError(`recursive CTE "${name}" needs a non-recursive SELECT seed`, binding.sql);
      }
      const next = new Set(active).add(binding);
      const rename = (rows: ScopeColumn[]) => rows.map((column, i) => ({ ...column, name: binding.columns[i] ?? column.name }));
      const scope = queryScope(binding.sql);
      if (scope.branches.length === 1 || scope.operators.some((op) => !op.startsWith("union"))) {
        return rename(this.scopeRows(binding.sql, binding.environment, next, note));
      }
      // The seed starts a monotone type union. Accept only a fixed point:
      // this proves that another recursive step cannot add a new value type.
      let rows = rename(this.scopeRows(scope.branches[0]!, binding.environment, next, note));
      try {
        for (let iteration = 0; iteration < 32; iteration++) {
          this.recursiveRows.set(binding, rows);
          const inferred = rename(this.scopeRows(binding.sql, binding.environment, next, note));
          const merged = rows.map((column, i) => this.mergeColumn(column, inferred[i]!, binding.sql));
          if (merged.every((column, i) => column.type === rows[i]!.type && column.json === rows[i]!.json)) return merged;
          if (merged.reduce((size, column) => size + column.type.length, 0) > 65_536) break;
          rows = merged;
        }
        throw new BuildError(`recursive CTE "${name}" result types do not stabilize within 32 steps and 65536 type characters. Use CAST for recursive expressions.`, binding.sql);
      } finally {
        this.recursiveRows.delete(binding);
      }
    }
    const view = this.engine.view(name);
    if (view) {
      const key = `view:${sqliteName(name)}`;
      if (active.has(key)) throw new BuildError(`recursive view "${name}" needs explicit type support`, view.sql);
      const rows = this.scopeRows(view.sql, new Map(), new Set(active).add(key), note);
      return rows.map((column, i) => ({ ...column, name: view.columns[i]! }));
    }
    const table = [...this.tables.values()].find((table) => sqliteName(table.name) === sqliteName(name));
    if (!table) throw new BuildError(`unknown source ${name}`, name);
    const rows: ScopeColumn[] = table.columns.map((column) => {
      const r = note(this.column(table.name, column.name, name));
      return { name: column.name, type: r.nullable ? unionType(r.type, "null") : r.type, json: false, ...(column.hidden ? { hidden: true } : {}) };
    });
    for (const name of rowIdentifiers) {
      if (implicitRowIdentifier(table, name)) rows.push({ name, type: "number", json: false, hidden: true });
    }
    return rows;
  }

  private scopedReference(ref: { alias: string | null; column: string }, context: ScopeContext, nullable = context.nullable): ScopeColumn | null {
    if (ref.alias !== null) {
      const alias = sqliteName(ref.alias);
      const rows = context.rows.get(alias);
      if (!rows) return context.parent ? this.scopedReference(ref, context.parent) : null;
      const column = rows.find((column) => sqliteName(column.name) === sqliteName(ref.column));
      return column ? nullable.has(alias) ? this.nullableColumn(column) : column : null;
    }
    const found = context.visible.filter((column) => sqliteName(column.name) === sqliteName(ref.column));
    if (found.length === 0) {
      for (const [alias, rows] of context.rows) for (const column of rows) {
        if (column.hidden && sqliteName(column.name) === sqliteName(ref.column)) found.push(nullable.has(alias) ? this.nullableColumn(column) : column);
      }
    }
    if (found.length === 1) return found[0]!;
    return found.length === 0 && context.parent ? this.scopedReference(ref, context.parent) : null;
  }

  private detachedProbe(sql: string, context: ScopeContext): string {
    if (!context.parent) return this.scopeProbe(sql, context.environment);
    const tokens = significant(tokenize(sql));
    const replacements: { start: number; end: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.type !== "ident" || tokens[i + 1]?.text !== "." || tokens[i + 2]?.type !== "ident") continue;
      const alias = sqliteName(unquote(token.text));
      if (!context.rows.has(alias) && this.scopedReference({ alias, column: unquote(tokens[i + 2]!.text) }, context.parent)) {
        replacements.push({ start: token.start, end: tokens[i + 2]!.end });
        i += 2;
      }
    }
    for (const replacement of replacements.reverse()) sql = sql.slice(0, replacement.start) + "null" + sql.slice(replacement.end);
    return this.scopeProbe(sql, context.environment);
  }

  private sourceContext(sql: string, environment: Map<string, Binding>, active: Set<Binding | string>, note: (r: Resolved) => Resolved, parent?: ScopeContext): { context: ScopeContext; aliases: Map<string, string | null> } {
    let sources: ReturnType<typeof querySources>;
    try { sources = querySources(sql); } catch (error) { throw new BuildError(`query scope: ${(error as Error).message}`, sql); }
    const context: ScopeContext = { rows: new Map(), visible: [], nullable: new Set(), environment, active, ...(parent ? { parent } : {}) };
    const aliases = new Map<string, string | null>();
    for (const source of sources) {
      const alias = sqliteName(source.alias);
      const rows = this.sourceRows(source, environment, active, note);
      const common = new Set((source.natural ? rows.filter((column) => !column.hidden && context.visible.some((left) => sqliteName(left.name) === sqliteName(column.name))).map((column) => column.name) : source.using).map(sqliteName));
      const before = context.visible;
      if (source.join === "right" || source.join === "full") {
        for (const previous of context.rows.keys()) context.nullable.add(previous);
        context.visible = context.visible.map((column) => this.nullableColumn(column));
      }
      context.rows.set(alias, rows);
      aliases.set(alias, source.name);
      if (source.join === "left" || source.join === "full") context.nullable.add(alias);
      context.visible = context.visible.map((column, i) => {
        if (!common.has(sqliteName(column.name))) return column;
        const right = rows.find((r) => sqliteName(r.name) === sqliteName(column.name))!;
        if (source.join === "right") return { ...right, name: column.name };
        if (source.join === "full") return this.mergeColumn(before[i]!, right, sql);
        return before[i]!;
      });
      context.visible.push(...rows.filter((column) => !column.hidden && !common.has(sqliteName(column.name))).map((column) => context.nullable.has(alias) ? this.nullableColumn(column) : column));
    }
    return { context, aliases };
  }

  private branchRows(sql: string, environment: Map<string, Binding>, active: Set<Binding | string>, note: (r: Resolved) => Resolved, parent?: ScopeContext): ScopeColumn[] {
    const tokens = significant(tokenize(sql));
    if (isKeyword(tokens[0], "values")) {
      const outputs = this.engine.columns(this.scopeProbe(sql, environment));
      let result: ScopeColumn[] | undefined;
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i]!.text !== "(" || tokens[i]!.depth !== 0) continue;
        const start = i + 1;
        while (++i < tokens.length && !(tokens[i]!.text === ")" && tokens[i]!.depth === 0)) {}
        const expressions = splitAtCommas(sql, tokens, start, i);
        // SELECT probes reuse expression inference; the runtime keeps VALUES.
        const row = this.branchRows(`select ${expressions.map((expr, j) => `${expr.text} as ${quoteIdent(outputs[j]!.name)}`).join(", ")}`, environment, active, note, parent);
        result = result ? result.map((column, j) => this.mergeColumn(column, row[j]!, sql)) : row;
      }
      if (!result) throw new BuildError("VALUES needs at least one row", sql);
      return result;
    }
    const { context, aliases } = this.sourceContext(sql, environment, active, note, parent);
    const probe = this.detachedProbe(sql, context);
    const outputs = this.engine.columns(probe);
    const items = selectItems(sql);
    if (!items) throw new BuildError("VALUES query scopes need an explicit SELECT", sql);
    const expanded: ({ column: ScopeColumn } | { item: NonNullable<ReturnType<typeof selectItems>>[number] })[] = [];
    for (const item of items) {
      const tokens = significant(tokenize(item.expr));
      if (tokens.length === 1 && tokens[0]!.text === "*") {
        expanded.push(...context.visible.map((column) => ({ column })));
      } else if (tokens.length === 3 && tokens[1]!.text === "." && tokens[2]!.text === "*") {
        const alias = sqliteName(unquote(tokens[0]!.text));
        const rows = context.rows.get(alias);
        if (!rows) throw new BuildError(`unknown wildcard source ${tokens[0]!.text}`, sql);
        expanded.push(...rows.filter((column) => !column.hidden).map((column) => ({ column: context.nullable.has(alias) ? this.nullableColumn(column) : column })));
      } else expanded.push({ item });
    }
    if (expanded.length !== outputs.length) throw new BuildError("query scope does not match SQLite's output columns", sql);
    const affinities = this.engine.affinities(probe);
    return expanded.map((entry, i) => {
      const out = outputs[i]!;
      if ("column" in entry) return { ...entry.column, name: out.name };
      const item = entry.item;
      const expr = stripParens(item.expr);
      const ref = columnRef(expr);
      const resolved = ref ? this.scopedReference(ref, context) : null;
      if (resolved) return { name: out.name, type: resolved.type, json: resolved.json };
      if (/^(?:select|with|values)\b/i.test(expr)) {
        const inner = this.scopeRows(expr, environment, active, note, context);
        if (inner.length !== 1) throw new BuildError("a scalar subquery must return one column", sql);
        return { ...this.nullableColumn(inner[0]!), name: out.name };
      }
      const literal = literalType(expr);
      if (literal !== null) return { name: out.name, type: literal, json: false };
      // The expression resolver owns CAST and JSON semantics. A column origin
      // alone cannot resolve a scalar subquery or a binding from another scope.
      return this.outputColumn(probe, { ...out, table: null, column: null }, { ...item, expr }, aliases, context.nullable, affinities, note, context);
    });
  }

  // RETURNING has one row source, the statement's own write target, so its
  // items type by the same rules a SELECT's items do (ADR 0100). The
  // scratch SELECT below stands in for the FROM list Engine.affinities
  // needs, since wrapping the DML statement itself is invalid SQL.
  private returningColumns(sql: string, outputs: OutputColumn[], aliases: Map<string, string | null>, note: (r: Resolved) => Resolved): Analysis["columns"] {
    const bare = () => outputs.map((out) => this.outputColumn(sql, out, null, aliases, new Set(), new Map(), note));
    const clause = returningClause(sql);
    if (!clause) return bare();
    const table = this.engine.accesses(sql).find((a) => a.action === "insert" || a.action === "update" || a.action === "delete")?.table;
    if (!table) return bare();
    const raw = selectItems(`select ${clause}`) ?? [];
    const target = this.tables.get(table);
    // RETURNING's only wildcard form SQLite accepts is a bare "*" (a
    // qualified "t.*" is a syntax error there); it expands to the target
    // table's own columns, in declaration order.
    const items = raw.flatMap((item) => {
      const tokens = significant(tokenize(item.expr));
      if (tokens.length === 1 && tokens[0]!.text === "*" && target) {
        return target.columns.map((c) => ({ ...item, text: quoteIdent(c.name), expr: quoteIdent(c.name), alias: null }));
      }
      return [item];
    });
    if (items.length !== outputs.length) return bare();
    const scratch = `select ${items.map((i) => i.text).join(", ")} from ${quoteIdent(table)}`;
    const affinities = this.engine.affinities(scratch);
    return outputs.map((out, i) => this.outputColumn(sql, out, items[i]!, aliases, new Set(), affinities, note));
  }

  private outputColumn(
    sql: string,
    out: OutputColumn,
    item: { expr: string; alias: string | null; text: string; start: number; end: number } | null,
    aliases: Map<string, string | null>,
    nullableAliases: Set<string>,
    affinities: Map<string, string>,
    note: (r: Resolved) => Resolved,
    scope?: ScopeContext,
  ): Analysis["columns"][number] {
    if (out.table && out.column) {
      const r = note(this.column(out.table, out.column, sql));
      const ref = item ? columnRef(item.expr) : null;
      const alias = ref?.alias ?? (ref ? this.aliasOfBareColumn(aliases, ref.column) : null);
      const unresolved = item !== null && (alias === null || aliases.get(alias) !== out.table);
      const joinNull = unresolved || (alias !== null && nullableAliases.has(alias));
      return { name: out.name, type: r.nullable || joinNull ? `${r.type} | null` : r.type, json: false };
    }
    const json = item ? jsonExpression(item.expr) : null;
    if (item && json?.kind === "array") {
      return { name: out.name, type: this.jsonArrayType(sql, { ...item, expr: json.expr }, aliases, nullableAliases, note, scope), json: true };
    }
    if (item && json?.kind === "object") {
      return { name: out.name, type: this.jsonObjectType(sql, json.expr, item, aliases, nullableAliases, note, false, scope), json: true };
    }
    const affinity = affinities.get(out.name) ?? "";
    // CTAS stores BLOB affinity as an empty declaration. A complete CAST
    // supplies the explicit binary type that this engine probe cannot retain.
    const cast = item ? castExpression(item.expr) : null;
    const scalar = affinityType(affinity) ?? (cast?.type === "Uint8Array" ? cast.type : null);
    if (scalar === null) {
      throw new BuildError(`column "${out.name}" is an expression with no type. Wrap it in cast(... as integer), cast(... as real), cast(... as text), or cast(... as blob).`, sql);
    }
    const notNull = item !== null && castNeverNull(item.expr, (ref) => this.refNullable(ref, aliases, nullableAliases, sql, scope));
    return { name: out.name, type: notNull ? scalar : `${scalar} | null`, json: false };
  }

  // Whether a column reference can be null here: its declaration, or the
  // outer side of a join. Null when the reference does not resolve.
  private refNullable(ref: { alias: string | null; column: string }, aliases: Map<string, string | null>, nullableAliases: Set<string>, sql: string, scope?: ScopeContext): boolean | null {
    if (scope) {
      const column = this.scopedReference(ref, scope, nullableAliases);
      if (column) return unionType(column.type, "null") === column.type || column.type === "SqlValue";
    }
    const alias = ref.alias ?? this.aliasOfBareColumn(aliases, ref.column);
    const table = alias === null ? null : aliases.get(alias) ?? null;
    if (!table) return null;
    const c = this.tables.get(table)?.columns.find((x) => sqliteName(x.name) === sqliteName(ref.column));
    if (!c) return null;
    void sql;
    return !c.notnull || (alias !== null && nullableAliases.has(alias));
  }

  private aliasOfBareColumn(aliases: Map<string, string | null>, column: string): string | null {
    const owners = [...aliases].filter(([, name]) => {
      const table = name === null ? undefined : this.tables.get(name);
      return table && (table.columns.some(c => sqliteName(c.name) === sqliteName(column)) || implicitRowIdentifier(table, column));
    });
    return owners.length === 1 ? owners[0]![0] : null;
  }

  // `json_group_array(json_object(...))` or `json_group_array(<expr>)`, with
  // an optional `filter (where ...)` that removes the rows of an outer join.
  private jsonArrayType(
    sql: string,
    item: { expr: string; text: string },
    aliases: Map<string, string | null>,
    nullableAliases: Set<string>,
    note: (r: Resolved) => Resolved,
    scope?: ScopeContext,
  ): string {
    const call = findCall(item.expr, "json_group_array")!;
    // Aggregate ORDER BY terms belong to the call, not its value. SQLite
    // validates arity and ordering syntax before this structural type step.
    const body = item.expr.slice(call.open + 1, call.close);
    const tokens = significant(tokenize(body));
    const start = isKeyword(tokens[0], "distinct") ? tokens[0]!.end : 0;
    const order = tokens.findIndex((token, i) => token.depth === 0 && isKeyword(token, "order") && isKeyword(tokens[i + 1], "by"));
    const inner = body.slice(start, order >= 0 ? tokens[order]!.start : body.length).trim();
    const hasFilter = /\bfilter\s*\(\s*where\b/i.test(item.expr.slice(call.close));
    const usedAliases = this.aliasesIn(inner, aliases);
    const outer = [...usedAliases].filter((a) => nullableAliases.has(a));
    if (outer.length > 0 && !hasFilter) {
      throw new BuildError(
        `json_group_array over the outer join alias "${outer[0]}" needs a filter, or a parent with no children gets one null element. Add: filter (where ${outer[0]}.<column> is not null)`,
        sql,
      );
    }
    // A FILTER clause alone does not prove that it removes the join rows.
    const excludedAlias = nonNullFilterAlias(item.expr.slice(call.close));
    const insideNullable = new Set([...nullableAliases].filter((a) => a !== excludedAlias));

    const element = jsonResultType(this.valueType(sql, inner, aliases, insideNullable, note, scope));
    return `Array<${element}>`;
  }

  private aliasesIn(expr: string, aliases: Map<string, string | null>): Set<string> {
    const out = new Set<string>();
    const t = significant(tokenize(expr));
    for (let i = 0; i + 2 < t.length; i++) {
      if (t[i]!.type === "ident" && t[i + 1]!.text === "." && t[i + 2]!.type === "ident" && aliases.has(unquote(t[i]!.text))) out.add(unquote(t[i]!.text));
    }
    return out;
  }

  private jsonObjectType(
    sql: string,
    expr: string,
    item: { text: string },
    aliases: Map<string, string | null>,
    nullableAliases: Set<string>,
    note: (r: Resolved) => Resolved,
    insideArray: boolean,
    scope?: ScopeContext,
  ): string {
    const call = findCall(expr, "json_object")!;
    if (call.args.length % 2 !== 0) throw new BuildError(`json_object needs key, value pairs`, sql);
    // JSON.parse retains the last occurrence of a repeated key. Preserve
    // that decoded contract instead of emitting duplicate TypeScript fields.
    const fields = new Map<string, string>();
    for (let i = 0; i < call.args.length; i += 2) {
      const key = call.args[i]!.text;
      const tokens = significant(tokenize(stripParens(key)));
      const m = tokens.length === 1 && tokens[0]!.type === "string" ? /^'((?:[^']|'')*)'$/.exec(tokens[0]!.text) : null;
      if (!m) throw new BuildError(`json_object key must be a string literal, got ${key}`, sql);
      const name = m[1]!.replace(/''/g, "'");
      const value = call.args[i + 1]!.text;
      fields.set(name, value);
    }
    const type = `{ ${[...fields].map(([name, value]) => `${JSON.stringify(name)}: ${jsonResultType(this.valueType(sql, value, aliases, nullableAliases, note, scope))}`).join("; ")} }`;
    void item;
    void insideArray;
    return type;
  }

  // The type of one value expression inside json_object or json_group_array:
  // a column reference resolves through the tables, a CAST through a probe
  // query, a `json((select json_group_array(...) ...))` subquery through
  // its own analysis, and anything else is an error.
  private valueType(sql: string, expr: string, aliases: Map<string, string | null>, nullableAliases: Set<string>, note: (r: Resolved) => Resolved, scope?: ScopeContext): string {
    expr = stripParens(expr);
    const shape = jsonExpression(expr);
    if (shape?.kind === "object") return this.jsonObjectType(sql, shape.expr, { text: expr }, aliases, nullableAliases, note, false, scope);
    if (shape?.kind === "array") return this.jsonArrayType(sql, { expr: shape.expr, text: expr }, aliases, nullableAliases, note, scope);
    const literal = literalType(expr);
    if (literal !== null) return literal;
    const nested = this.nestedJsonType(sql, expr, aliases, note, scope);
    if (nested !== null) return nested;
    const ref = columnRef(expr);
    if (ref) {
      const resolved = scope ? this.scopedReference(ref, scope, nullableAliases) : null;
      if (resolved) return resolved.json ? "string" : resolved.type;
      const alias = ref.alias ?? this.aliasOfBareColumn(aliases, ref.column);
      const table = alias === null ? null : aliases.get(alias) ?? null;
      if (!table) throw new BuildError(`cannot find the table of ${expr}`, sql);
      const r = note(this.column(table, ref.column, sql));
      const joinNull = alias !== null && nullableAliases.has(alias);
      return r.nullable || joinNull ? `${r.type} | null` : r.type;
    }
    const cast = castExpression(expr);
    if (cast && cast.type !== "unknown") {
      return castNeverNull(expr, (r) => this.refNullable(r, aliases, nullableAliases, sql, scope)) ? cast.type : `${cast.type} | null`;
    }
    throw new BuildError(`value "${expr}" inside json has no type. Use a column reference, cast(... as integer | real | text), or json((select json_group_array(...) ...)).`, sql);
  }

  // A one-to-many inside a one-to-many: `json((select json_group_array(...)
  // from child where child.parent_id = outer.id))`. The subquery is analyzed
  // on its own, with each reference to an alias of the outer statement
  // replaced by NULL, which prepares the same and changes no type. The json()
  // call is required: a subquery's text has no JSON subtype, so without it
  // the array would nest as a string.
  private nestedJsonType(sql: string, expr: string, aliases: Map<string, string | null>, note: (r: Resolved) => Resolved, scope?: ScopeContext): string | null {
    const bare = /^select\b/i.test(stripParens(expr));
    const call = completeCall(expr, "json");
    const wrapped = call !== null && call.args.length === 1 && /^select\b/i.test(stripParens(call.args[0]!.text));
    if (!bare && !wrapped) return null;
    const subquery = stripParens(wrapped ? call!.args[0]!.text : expr);
    const items = selectItems(subquery);
    if (!items || items.length !== 1) throw new BuildError(`a subquery inside json must select one value, got ${items?.length ?? 0}`, sql);
    const item = items[0]!;
    const shape = jsonExpression(item.expr);
    const isArray = shape?.kind === "array";
    const isObject = shape?.kind === "object";
    if (!isArray && !isObject) return null;
    if (!wrapped) throw new BuildError(`the subquery "${expr}" inside json yields JSON text. Wrap it in json(...) so it nests as JSON, not as a string.`, sql);
    if (scope) {
      const rows = this.scopeRows(subquery, scope.environment, scope.active, note, scope);
      return isArray ? rows[0]!.type : unionType(rows[0]!.type, "null");
    }
    // Outer alias references become NULL, so the subquery prepares alone.
    const innerAliases = aliasMap(subquery);
    const tokens = tokenize(subquery);
    let detached = "";
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      const next = tokens[i + 1];
      const after = tokens[i + 2];
      if (t.type === "ident" && next?.text === "." && after?.type === "ident" && aliases.has(unquote(t.text)) && !innerAliases.has(unquote(t.text))) {
        detached += "null";
        i += 2;
        continue;
      }
      detached += t.text;
    }
    try {
      this.engine.prepare(detached);
    } catch (e) {
      throw new BuildError(`inside json: ${(e as Error).message}`, sql);
    }
    const innerNullable = this.engine.nullableAliases(detached);
    const innerItem = selectItems(detached)![0]!;
    if (isArray) return this.jsonArrayType(detached, innerItem, innerAliases, innerNullable, note);
    // A subquery with no row is NULL.
    return `${this.jsonObjectType(detached, innerItem.expr, innerItem, innerAliases, innerNullable, note, false)} | null`;
  }

  private parameterScopes(sql: string, offset: number): { start: number; end: number; depth: number }[] {
    const tokens = significant(tokenize(sql));
    const scopes: { start: number; end: number; depth: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!isKeyword(token, "select") || token.start > offset) continue;
      let end = sql.length;
      for (let j = i + 1; j < tokens.length; j++) {
        const next = tokens[j]!;
        if (next.depth < token.depth || (next.depth === token.depth && ["union", "intersect", "except"].some(word => isKeyword(next, word)))) {
          end = next.start;
          break;
        }
      }
      if (offset < end) scopes.push({ start: token.start, end, depth: token.depth });
    }
    return scopes.sort((a, b) => a.depth - b.depth);
  }

  private parameterContext(sql: string, offset: number, note: (r: Resolved) => Resolved): ScopeContext | undefined {
    const tokens = significant(tokenize(sql));
    let context: ScopeContext | undefined;
    for (const scope of this.parameterScopes(sql, offset)) {
      let environment = new Map<string, Binding>();
      // Each enclosing SELECT keeps its own WITH environment. A nested WITH
      // must not change the sources of a correlated outer reference.
      for (const token of tokens) {
        if (!isKeyword(token, "with") || token.start > scope.start) continue;
        const end = tokens.find(next => next.start > token.start && next.depth < token.depth)?.start ?? sql.length;
        if (scope.start >= end) continue;
        const bindings = queryScope(sql.slice(token.start, end), true);
        environment = new Map(environment);
        for (const cte of bindings.ctes) environment.set(sqliteName(cte.name), { ...cte, environment });
      }
      context = this.sourceContext(sql.slice(scope.start, scope.end), environment, new Set(), note, context).context;
    }
    return context;
  }

  // The type of one named parameter, from where it sits in the statement.
  // Sites that name a column must agree on the base type. The parameter
  // allows null when every such site does, or when `:p is null` appears.
  // CASE lists union their literals. json_each sites union their keys.
  private paramType(sql: string, name: string, aliases: Map<string, string | null>, note: (r: Resolved) => Resolved): { type: string; encode: boolean } {
    const sites = paramSites(sql, true).get(name) ?? [];
    let context: ScopeContext | undefined;
    const types = new Set<string>();
    const columnSites: Resolved[] = [];
    const literals: string[] = [];
    const jsonKeys = new Map<string, string>();
    let jsonScalar: string | null = null;
    let jsonSites = 0;
    let encode = false;
    let nullable = false;
    const withNull = (r: Resolved) => (r.nullable ? `${note(r).type} | null` : note(r).type);
    const ofRef = (alias: string | null, column: string): Resolved | null => {
      const resolved = context ? this.scopedReference({ alias, column }, context) : null;
      if (resolved) {
        const members = unionMembers(resolved.type);
        const nullable = members.includes("null") || resolved.type === "SqlValue";
        const type = resolved.json ? "string" : members.filter(member => member !== "null").join(" | ") || "null";
        return { type, nullable, brand: null };
      }
      if (context && isSelect(sql)) return null;
      const a = alias ?? this.aliasOfBareColumn(aliases, column);
      const table = a === null ? null : aliases.get(a) ?? null;
      return table && this.tables.has(table) ? this.column(table, column, sql) : null;
    };
    for (const site of sites) {
      context = this.parameterContext(sql, site.offset ?? 0, note);
      let r: Resolved | null = null;
      if (site.kind === "compare") {
        r = ofRef(site.alias, site.column);
      } else if (site.kind === "insert") {
        r = this.column(site.table, site.column, sql);
      } else if (site.kind === "set") {
        const table = updateTarget(sql);
        if (table) r = this.column(table, site.column, sql);
      } else if (site.kind === "in_json") {
        const e = ofRef(site.alias, site.column);
        if (e) {
          types.add(`readonly ${unionMembers(note(e).type).length > 1 ? `(${e.type})` : e.type}[]`);
          encode = true;
        }
        continue;
      } else if (site.kind === "rows_json") {
        const fields = site.keys.map((k) => `${JSON.stringify(k.key)}: ${withNull(this.column(site.table, k.column, sql))}`);
        types.add(`readonly { ${fields.join("; ")} }[]`);
        encode = true;
        continue;
      } else if (site.kind === "json_each") {
        encode = true;
        jsonSites++;
        for (const k of site.keys) {
          const e = k.ref ? ofRef(k.ref.alias, k.ref.column) : null;
          const type = e ? withNull(e) : "SqlValue";
          if (!jsonKeys.has(k.key) || (jsonKeys.get(k.key) === "SqlValue" && type !== "SqlValue")) jsonKeys.set(k.key, type);
        }
        if (site.scalar) jsonScalar = withNull(this.column(site.scalar.table, site.scalar.column, sql));
        continue;
      } else if (site.kind === "one_of") {
        literals.push(...site.literals);
        continue;
      } else if (site.kind === "number") {
        types.add("number");
        continue;
      } else if (site.kind === "nullable") {
        nullable = true;
        continue;
      }
      if (r) columnSites.push(note(r));
    }
    if (columnSites.length > 0) {
      const bases = new Set(columnSites.map((r) => r.type));
      if (bases.size > 1) throw new BuildError(`parameter ${JSON.stringify(name)} is used with two different types: ${[...bases].join(" and ")}`, sql);
      const base = [...bases][0]!;
      types.add(columnSites.every((r) => r.nullable) ? `${base} | null` : base);
    }
    if (literals.length > 0) types.add([...new Set(literals)].map((l) => JSON.stringify(l)).join(" | "));
    if (jsonSites > 0) {
      if (jsonKeys.size > 0) types.add(`readonly { ${[...jsonKeys].map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join("; ")} }[]`);
      else if (jsonScalar !== null) types.add(`readonly ${jsonScalar}[]`);
      else types.add("readonly SqlValue[]");
    }
    if (types.size > 1) throw new BuildError(`parameter ${JSON.stringify(name)} is used with two different types: ${[...types].join(" and ")}`, sql);
    let type = types.size === 1 ? [...types][0]! : "SqlValue";
    if (nullable && type !== "SqlValue" && !/\| null$/.test(type)) type = `${type} | null`;
    return { type, encode };
  }
}

// An expression column is `| null` unless its CAST wraps a shape the engine
// never returns null for: count, total, a ranking window function, exists,
// coalesce/ifnull whose last argument is a literal or a NOT NULL column, or
// a bare column reference the schema declares NOT NULL. The call must be
// the whole expression, with only FILTER and OVER after it, so
// `count(*) / nullif(x, 0)` stays nullable.
const neverNullCalls = new Set(["count", "total", "row_number", "rank", "dense_rank", "ntile", "coalesce", "ifnull"]);

export function castNeverNull(expr: string, columnNullable: (ref: { alias: string | null; column: string }) => boolean | null): boolean {
  const cast = castExpression(expr);
  if (!cast) return false;
  const inner = stripParens(cast.inner);
  const t = significant(tokenize(inner));
  const first = t[0];
  if (!first) return false;
  const exists = isKeyword(first, "exists") ? 0 : isKeyword(first, "not") && isKeyword(t[1], "exists") ? 1 : -1;
  if (exists >= 0) {
    const open = t[exists + 1];
    return open?.text === "(" && t.findIndex((token, i) => i > exists + 1 && token.text === ")" && token.depth === open.depth) === t.length - 1;
  }
  // A CAST whose whole inner expression is one bare column reference (no
  // call, no operator) is non-null exactly when that column is: the same
  // rule the coalesce/ifnull branch below already applies to its last
  // argument.
  const bareColumn = columnRef(inner);
  if (bareColumn !== null) return columnNullable(bareColumn) === false;
  if (first.type !== "ident" || t[1]?.text !== "(") return false;
  const fn = first.text.toLowerCase();
  if (!neverNullCalls.has(fn)) return false;
  // The call spans the expression: after its ")" only FILTER (...) and OVER (...).
  let i = 2;
  while (t[i] && !(t[i]!.text === ")" && t[i]!.depth === t[1]!.depth)) i++;
  i++;
  while (t[i]) {
    if ((isKeyword(t[i], "filter") || isKeyword(t[i], "over")) && t[i + 1]?.text === "(") {
      const d = t[i + 1]!.depth;
      i += 2;
      while (t[i] && !(t[i]!.text === ")" && t[i]!.depth === d)) i++;
      i++;
    } else return false;
  }
  if (fn !== "coalesce" && fn !== "ifnull") return true;
  const call = findCall(inner, fn)!;
  const last = call.args[call.args.length - 1]!.text;
  const lt = significant(tokenize(last));
  if (lt.length === 1 && (lt[0]!.type === "number" || lt[0]!.type === "string")) return true;
  const ref = columnRef(last);
  return ref !== null && columnNullable(ref) === false;
}

// The table an UPDATE changes, or the table an INSERT ... ON CONFLICT DO
// UPDATE changes.
function updateTarget(sql: string): string | null {
  const t = significant(tokenize(sql));
  let i = 0;
  if (isKeyword(t[0], "insert")) {
    i = isKeyword(t[1], "or") ? 4 : 2;
  } else if (isKeyword(t[0], "replace")) {
    i = 2;
  } else if (isKeyword(t[0], "update")) {
    i = isKeyword(t[1], "or") ? 3 : 1;
  } else return null;
  return t[i]?.type === "ident" ? unquote(t[i]!.text) : null;
}

export function isSelect(sql: string): boolean {
  const tokens = significant(tokenize(sql));
  const first = isKeyword(tokens[0], "with")
    ? tokens.find((token) => token.depth === 0 && ["select", "values", "insert", "update", "delete", "replace"].some((verb) => isKeyword(token, verb)))
    : tokens[0];
  return isKeyword(first, "select") || isKeyword(first, "values");
}


function stripParens(expr: string): string {
  for (;;) {
    const tokens = significant(tokenize(expr));
    if (tokens[0]?.text !== "(" || tokens[tokens.length - 1]?.text !== ")") return expr.trim();
    const closing = tokens.findIndex((token, i) => i > 0 && token.text === ")" && token.depth === 0);
    if (closing !== tokens.length - 1) return expr.trim();
    expr = expr.slice(tokens[0]!.end, tokens[closing]!.start);
  }
}

function literalType(expr: string): string | null {
  const tokens = significant(tokenize(expr));
  if (tokens.length === 1) {
    if (isKeyword(tokens[0], "null")) return "null";
    if (tokens[0]!.type === "string") return "string";
    if (tokens[0]!.type === "number" || isKeyword(tokens[0], "true") || isKeyword(tokens[0], "false")) return "number";
  }
  // SQLite requires the hex prefix and string to be adjacent. Keep string
  // aliases and separated tokens from acquiring a binary result contract.
  if (tokens.length === 2 && /^[xX]$/.test(tokens[0]!.text) && tokens[0]!.end === tokens[1]!.start && /^'(?:[0-9a-fA-F]{2})*'$/.test(tokens[1]!.text)) return "Uint8Array";
  if (tokens.length === 2 && ["-", "+"].includes(tokens[0]!.text) && tokens[1]!.type === "number") return "number";
  return null;
}

// A nested function cannot define its enclosing expression's decoding policy.
// SQLite validates clause syntax; this check only verifies the call's boundary.
function completeCall(expr: string, name: string, aggregate = false): ReturnType<typeof findCall> {
  const tokens = significant(tokenize(expr));
  if (!isKeyword(tokens[0], name) || tokens[1]?.text !== "(") return null;
  const call = findCall(expr, name);
  if (!call || call.open !== tokens[1].start) return null;
  let i = tokens.findIndex(token => token.start === call.close) + 1;
  while (aggregate && i < tokens.length) {
    const over = isKeyword(tokens[i], "over");
    if (!over && !isKeyword(tokens[i], "filter")) return null;
    i++;
    if (tokens[i]?.text === "(") {
      const depth = tokens[i]!.depth;
      i++;
      while (tokens[i] && !(tokens[i]!.text === ")" && tokens[i]!.depth === depth)) i++;
      if (!tokens[i]) return null;
      i++;
    } else if (over && tokens[i]?.type === "ident") i++;
    else return null;
  }
  return i === tokens.length ? call : null;
}

function jsonExpression(input: string): { kind: "array" | "object"; expr: string } | null {
  const expr = stripParens(input);
  if (completeCall(expr, "json_object")) return { kind: "object", expr };
  if (completeCall(expr, "json_group_array", true)) return { kind: "array", expr };
  const fallback = completeCall(expr, "coalesce");
  if (fallback?.args.length === 2 && stripParens(fallback.args[1]!.text) === "'[]'") {
    const shape = jsonExpression(fallback.args[0]!.text);
    if (shape?.kind === "array") return shape;
  }
  return null;
}

// Read the outer CAST only. Comments and type-name syntax do not change
// SQLite's conversion, and an inner CAST cannot type an enclosing operator.
function castExpression(input: string): { inner: string; type: string } | null {
  const expr = stripParens(input);
  const call = completeCall(expr, "cast");
  if (!call || call.args.length !== 1) return null;
  const tokens = significant(tokenize(expr));
  const as = tokens.findIndex(token => token.depth === 1 && isKeyword(token, "as"));
  if (as < 0) return null;
  const name = tokens.slice(as + 1, -1).map(token => unquote(token.text)).join(" ");
  return { inner: expr.slice(call.open + 1, tokens[as]!.start).trim(), type: scalarType(name) };
}
