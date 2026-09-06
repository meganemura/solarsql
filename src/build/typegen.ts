// Responsibility: turn one SQL statement into its entry of the generated
// map: the parameters it takes, the row it returns, and the columns that
// hold JSON. Every type comes from the engine (facts.ts) and from the
// fixed text shapes of scan.ts. This file emits TypeScript type text.
// Boundary: no file system, no module layout, no boundary check. build.ts
// owns those. A shape this file cannot type becomes a BuildError with the
// SQL and the reason.
import type { ColumnFact, Engine, OutputColumn, TableFact } from "./facts.ts";
import { aliasMap, columnRef, findCall, isKeyword, leadingComment, namedParams, paramSites, selectItems, significant, tokenize, unquote } from "./scan.ts";

export class BuildError extends Error {
  readonly sql: string | undefined;
  constructor(message: string, sql?: string) {
    super(sql === undefined ? message : `${message}\n  in: ${sql.replace(/\s+/g, " ").trim()}`);
    this.name = "BuildError";
    this.sql = sql;
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

type Resolved = { type: string; nullable: boolean; brand: string | null };

export class Typer {
  private readonly tables = new Map<string, TableFact>();
  private readonly engine: Engine;
  private readonly brands: Map<string, Brand>;

  constructor(engine: Engine, brands: Map<string, Brand>) {
    this.engine = engine;
    this.brands = brands;
    for (const t of engine.tables()) this.tables.set(t.name, t);
  }

  // The base type of one table column, before nullability from a join.
  column(table: string, column: string, sql: string): Resolved {
    const t = this.tables.get(table);
    const c = t?.columns.find((x) => x.name === column);
    if (!t || !c) throw new BuildError(`unknown column ${table}.${column}`, sql);
    const brand = this.brandOf(t, c);
    if (brand) return { type: brand.typeName, nullable: !c.notnull, brand: brand.typeName };
    if (c.oneOf) return { type: c.oneOf.map((v) => JSON.stringify(v)).join(" | "), nullable: !c.notnull, brand: null };
    const scalar = scalarType(c.type);
    if (scalar === "unknown") throw new BuildError(`column ${table}.${column} has the declared type "${c.type}", which maps to no TypeScript type. Use text, integer, real, or blob.`, sql);
    return { type: scalar, nullable: !c.notnull, brand: null };
  }

  private brandOf(t: TableFact, c: ColumnFact): Brand | null {
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
    const nullableAliases = select ? this.engine.nullableAliases(sql) : new Set<string>();
    const outputs = this.engine.columns(sql);
    const returnsRows = outputs.length > 0;
    const columns: Analysis["columns"] = [];
    if (returnsRows) {
      // RETURNING has no select list to scan and no probe through CREATE
      // TABLE AS, so its columns must be column references.
      const items = select ? selectItems(sql) : null;
      const affinities = select ? this.engine.affinities(sql) : new Map<string, string>();
      for (const [i, out] of outputs.entries()) {
        const item = items?.[i] ?? null;
        columns.push(this.outputColumn(sql, out, item, aliases, nullableAliases, affinities, note));
      }
    }
    const params = names.map((name) => ({ name, ...this.paramType(sql, name, aliases, note) }));
    const scans = select && /\bwhere\b/i.test(sql) ? this.engine.fullScans(sql) : [];
    return { sql, doc: leadingComment(sql), returnsRows, params, columns, brands, scans };
  }

  private outputColumn(
    sql: string,
    out: OutputColumn,
    item: { expr: string; alias: string | null; text: string; start: number; end: number } | null,
    aliases: Map<string, string | null>,
    nullableAliases: Set<string>,
    affinities: Map<string, string>,
    note: (r: Resolved) => Resolved,
  ): Analysis["columns"][number] {
    if (out.table && out.column) {
      const r = note(this.column(out.table, out.column, sql));
      const ref = item ? columnRef(item.expr) : null;
      const alias = ref?.alias ?? (ref ? this.aliasOfBareColumn(aliases, ref.column) : null);
      const joinNull = alias !== null && nullableAliases.has(alias);
      return { name: out.name, type: r.nullable || joinNull ? `${r.type} | null` : r.type, json: false };
    }
    if (item && findCall(item.expr, "json_group_array")) {
      return { name: out.name, type: this.jsonArrayType(sql, item, aliases, nullableAliases, note), json: true };
    }
    if (item && findCall(item.expr, "json_object")) {
      return { name: out.name, type: this.jsonObjectType(sql, item.expr, item, aliases, nullableAliases, note, false), json: true };
    }
    const affinity = affinities.get(out.name) ?? "";
    const scalar = affinityType(affinity);
    if (scalar === null) {
      throw new BuildError(`column "${out.name}" is an expression with no type. Wrap it in cast(... as integer), cast(... as real), or cast(... as text).`, sql);
    }
    const notNull = item !== null && castNeverNull(item.expr, (ref) => this.refNullable(ref, aliases, nullableAliases, sql));
    return { name: out.name, type: notNull ? scalar : `${scalar} | null`, json: false };
  }

  // Whether a column reference can be null here: its declaration, or the
  // outer side of a join. Null when the reference does not resolve.
  private refNullable(ref: { alias: string | null; column: string }, aliases: Map<string, string | null>, nullableAliases: Set<string>, sql: string): boolean | null {
    const alias = ref.alias ?? this.aliasOfBareColumn(aliases, ref.column);
    const table = alias === null ? null : aliases.get(alias) ?? null;
    if (!table) return null;
    const c = this.tables.get(table)?.columns.find((x) => x.name === ref.column);
    if (!c) return null;
    void sql;
    return !c.notnull || (alias !== null && nullableAliases.has(alias));
  }

  private aliasOfBareColumn(aliases: Map<string, string | null>, column: string): string | null {
    const owners = [...aliases].filter(([, table]) => table !== null && this.tables.get(table)?.columns.some((c) => c.name === column));
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
  ): string {
    const call = findCall(item.expr, "json_group_array")!;
    if (call.args.length !== 1) throw new BuildError(`json_group_array takes one argument`, sql);
    const inner = call.args[0]!.text;
    const hasFilter = /\bfilter\s*\(\s*where\b/i.test(item.expr.slice(call.close));
    const usedAliases = this.aliasesIn(inner, aliases);
    const outer = [...usedAliases].filter((a) => nullableAliases.has(a));
    if (outer.length > 0 && !hasFilter) {
      throw new BuildError(
        `json_group_array over the outer join alias "${outer[0]}" needs a filter, or a parent with no children gets one null element. Add: filter (where ${outer[0]}.<column> is not null)`,
        sql,
      );
    }
    // Inside the array the filter has removed the rows the join added.
    const insideNullable = new Set([...nullableAliases].filter((a) => !usedAliases.has(a)));
    if (findCall(inner, "json_object")) return `Array<${this.jsonObjectType(sql, inner, item, aliases, insideNullable, note, true)}>`;
    const element = this.valueType(sql, inner, aliases, insideNullable, note);
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
  ): string {
    const call = findCall(expr, "json_object")!;
    if (call.args.length % 2 !== 0) throw new BuildError(`json_object needs key, value pairs`, sql);
    const fields: string[] = [];
    for (let i = 0; i < call.args.length; i += 2) {
      const key = call.args[i]!.text;
      const m = /^'((?:[^']|'')*)'$/.exec(key);
      if (!m) throw new BuildError(`json_object key must be a string literal, got ${key}`, sql);
      const name = m[1]!.replace(/''/g, "'");
      const value = call.args[i + 1]!.text;
      fields.push(`${JSON.stringify(name)}: ${this.valueType(sql, value, aliases, nullableAliases, note)}`);
    }
    const type = `{ ${fields.join("; ")} }`;
    void item;
    void insideArray;
    return type;
  }

  // The type of one value expression inside json_object or json_group_array:
  // a column reference resolves through the tables, a CAST through a probe
  // query, and anything else is an error.
  private valueType(sql: string, expr: string, aliases: Map<string, string | null>, nullableAliases: Set<string>, note: (r: Resolved) => Resolved): string {
    const ref = columnRef(expr);
    if (ref) {
      const alias = ref.alias ?? this.aliasOfBareColumn(aliases, ref.column);
      const table = alias === null ? null : aliases.get(alias) ?? null;
      if (!table) throw new BuildError(`cannot find the table of ${expr}`, sql);
      const r = note(this.column(table, ref.column, sql));
      const joinNull = alias !== null && nullableAliases.has(alias);
      return r.nullable || joinNull ? `${r.type} | null` : r.type;
    }
    const cast = findCall(expr, "cast");
    if (cast && cast.open === expr.toLowerCase().indexOf("cast(") + 4) {
      const m = /\bas\s+([A-Za-z]+)\s*$/i.exec(cast.args[0]!.text);
      if (m) {
        const scalar = scalarType(m[1]!);
        if (scalar !== "unknown") return castNeverNull(expr, (r) => this.refNullable(r, aliases, nullableAliases, sql)) ? scalar : `${scalar} | null`;
      }
    }
    throw new BuildError(`value "${expr}" inside json has no type. Use a column reference or cast(... as integer | real | text).`, sql);
  }

  // The type of one named parameter, from where it sits in the statement.
  private paramType(sql: string, name: string, aliases: Map<string, string | null>, note: (r: Resolved) => Resolved): { type: string; encode: boolean } {
    const sites = paramSites(sql).get(name) ?? [];
    const types = new Set<string>();
    let encode = false;
    let nullable = false;
    const withNull = (r: Resolved) => (r.nullable ? `${note(r).type} | null` : note(r).type);
    const ofRef = (alias: string | null, column: string): Resolved | null => {
      const a = alias ?? this.aliasOfBareColumn(aliases, column);
      const table = a === null ? null : aliases.get(a) ?? null;
      return table ? this.column(table, column, sql) : null;
    };
    for (const site of sites) {
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
          types.add(`readonly ${note(e).type}[]`);
          encode = true;
        }
        continue;
      } else if (site.kind === "rows_json") {
        const fields = site.keys.map((k) => `${JSON.stringify(k.key)}: ${withNull(this.column(site.table, k.column, sql))}`);
        types.add(`readonly { ${fields.join("; ")} }[]`);
        encode = true;
        continue;
      } else if (site.kind === "one_of") {
        types.add(site.literals.map((l) => JSON.stringify(l)).join(" | "));
        continue;
      } else if (site.kind === "number") {
        types.add("number");
        continue;
      } else if (site.kind === "nullable") {
        nullable = true;
        continue;
      }
      if (r) types.add(withNull(r));
    }
    if (types.size > 1) throw new BuildError(`parameter :${name} is used with two different types: ${[...types].join(" and ")}`, sql);
    let type = types.size === 1 ? [...types][0]! : "SqlValue";
    if (nullable && type !== "SqlValue" && !/\| null$/.test(type)) type = `${type} | null`;
    return { type, encode };
  }
}

// An expression column is `| null` unless its CAST wraps a shape the engine
// never returns null for: count, total, a ranking window function, exists,
// or coalesce/ifnull whose last argument is a literal or a NOT NULL column.
// The call must be the whole expression, with only FILTER and OVER after
// it, so `count(*) / nullif(x, 0)` stays nullable.
const neverNullCalls = new Set(["count", "total", "row_number", "rank", "dense_rank", "ntile", "coalesce", "ifnull"]);

export function castNeverNull(expr: string, columnNullable: (ref: { alias: string | null; column: string }) => boolean | null): boolean {
  if (!/^\s*cast\s*\(/i.test(expr)) return false;
  const cast = findCall(expr, "cast");
  if (!cast || cast.args.length !== 1) return false;
  const inner = cast.args[0]!.text.replace(/\s+as\s+[A-Za-z]+\s*$/i, "");
  const t = significant(tokenize(inner));
  const first = t[0];
  if (!first) return false;
  if (isKeyword(first, "exists") || (isKeyword(first, "not") && isKeyword(t[1], "exists"))) return true;
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
  } else if (isKeyword(t[0], "update")) {
    i = isKeyword(t[1], "or") ? 3 : 1;
  } else return null;
  return t[i]?.type === "ident" ? unquote(t[i]!.text) : null;
}

function isSelect(sql: string): boolean {
  const first = significant(tokenize(sql))[0];
  return isKeyword(first, "select") || isKeyword(first, "with") || isKeyword(first, "values");
}
