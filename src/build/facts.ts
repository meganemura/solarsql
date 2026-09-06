// Responsibility: the facts about SQL that come from the engine.
// One in-memory node:sqlite database holds the declared schema. Every
// question below is answered by preparing a statement in it: column origins,
// declared types, nullability, foreign keys, the nullable side of a join,
// the affinity of an expression, and the tables a statement touches.
// Boundary: nothing here reads SQL text beyond what scan.ts provides. Nothing
// here produces TypeScript; typegen.ts does that from these facts.
import { DatabaseSync, constants } from "node:sqlite";
import { aliasMap, definitions, normalize, quoteIdent, tokenize, unquote } from "./scan.ts";

export type ColumnFact = {
  name: string;
  type: string;
  notnull: boolean;
  dflt: string | null;
  pk: number;
  // Literals of `check (<column> in (...))`, when the column has one.
  oneOf: (string | number)[] | null;
  // A generated column (`as (...) stored` or `virtual`) is read, never written.
  generated: boolean;
};

export type ForeignKeyFact = { table: string; from: string; to: string };

export type TableFact = {
  name: string;
  sql: string;
  columns: ColumnFact[];
  foreignKeys: ForeignKeyFact[];
  withoutRowid: boolean;
  // A STRICT table rejects a value whose storage class differs from the
  // declared type, so the generated types hold for every stored value.
  strict: boolean;
};

export type OutputColumn = {
  name: string;
  table: string | null;
  column: string | null;
  type: string | null;
};

export type Access = {
  action: "read" | "insert" | "update" | "delete" | "function" | "other";
  table: string | null;
  column: string | null;
  // The view or trigger that caused the access, when the access is indirect.
  via: string | null;
};

export class Engine {
  readonly db: DatabaseSync;

  // A statement the engine refuses is reported with its text, so a bad
  // trigger body or view names itself.
  constructor(statements: readonly string[]) {
    this.db = new DatabaseSync(":memory:");
    for (const s of statements) {
      try {
        this.db.exec(s);
      } catch (e) {
        throw new Error(`${(e as Error).message}\n  in: ${s.replace(/\s+/g, " ").trim()}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  tables(): TableFact[] {
    const rows = this.db
      .prepare(`select name, sql from sqlite_schema where type = 'table' and sql is not null and name not like 'sqlite_%' order by name`)
      .all() as { name: string; sql: string }[];
    return rows.map((r) => this.table(r.name, r.sql));
  }

  table(name: string, sql?: string): TableFact {
    const ddl = sql ?? (this.db.prepare(`select sql from sqlite_schema where type = 'table' and name = ?`).get(name) as { sql: string } | undefined)?.sql;
    if (!ddl) throw new Error(`no table named ${name}`);
    const defs = definitions(ddl);
    // hidden: 0 is a plain column, 2 a virtual generated column, 3 a stored
    // one. 1 is the hidden column of a virtual table.
    const columns = (this.db.prepare(`select name, type, "notnull" as nn, dflt_value, pk, hidden from pragma_table_xinfo(?) where hidden in (0, 2, 3)`).all(name) as {
      name: string;
      type: string;
      nn: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }[]).map((c) => ({
      name: c.name,
      type: c.type,
      notnull: c.nn === 1,
      dflt: c.dflt_value,
      pk: c.pk,
      oneOf: oneOfLiterals(defs?.columns.get(c.name) ?? "", c.name),
      generated: c.hidden !== 0,
    }));
    const foreignKeys = (this.db.prepare(`select "table", "from", "to" from pragma_foreign_key_list(?) order by id, seq`).all(name) as { table: string; from: string; to: string }[]).map((f) => ({
      table: f.table,
      from: f.from,
      to: f.to,
    }));
    const tail = ddl.slice(ddl.lastIndexOf(")"));
    return { name, sql: ddl, columns, foreignKeys, withoutRowid: /\bwithout\s+rowid\b/i.test(tail), strict: /\bstrict\b/i.test(tail) };
  }

  // The first column of a table or a view that a statement may set. A
  // generated column cannot be set, so it is skipped.
  firstSettableColumn(name: string): string | null {
    const row = this.db.prepare(`select name from pragma_table_xinfo(?) where hidden = 0 order by cid limit 1`).get(name) as { name: string } | undefined;
    return row?.name ?? null;
  }

  // The output columns of a statement, with the origin of each.
  columns(sql: string): OutputColumn[] {
    return this.db.prepare(sql).columns().map((c) => ({ name: c.name, table: c.table, column: c.column, type: c.type }));
  }

  // Preparing alone finds syntax errors and unknown names.
  prepare(sql: string): void {
    this.db.prepare(sql);
  }

  // Aliases on the nullable side of an outer join, from EXPLAIN QUERY PLAN.
  // The engine drops the mark when a WHERE clause excludes NULL, which is
  // more precise than the text.
  nullableAliases(sql: string): Set<string> {
    const out = new Set<string>();
    for (const r of this.db.prepare(`explain query plan ${sql}`).all()) {
      const m = /^(?:SCAN|SEARCH)\s+(\S+)\b.*\bLEFT-JOIN\b/.exec((r as { detail: string }).detail);
      if (m) out.add(unquote(m[1]!));
    }
    return out;
  }

  // Tables the plan reads in full (`SCAN t`), by table name. An optional
  // filter written as `(:p is null or col = :p)` disables the index, and
  // this is how the build tells the agent.
  fullScans(sql: string): string[] {
    // The plan names the alias; the text maps it back to the table.
    const aliases = aliasMap(sql);
    const out: string[] = [];
    for (const r of this.db.prepare(`explain query plan ${sql}`).all()) {
      const detail = (r as { detail: string }).detail;
      // json_each is a parameter, and a scan of it is its only plan.
      if (detail.includes("VIRTUAL TABLE")) continue;
      // A scan through an index, covering or not, still visits every row.
      const m = /^SCAN\s+(\S+)(?:\s+USING\s+(?:COVERING\s+)?INDEX\s+\S+)?$/.exec(detail);
      if (!m) continue;
      const alias = unquote(m[1]!);
      const table = aliases.get(alias) ?? alias;
      if (table && !out.includes(table)) out.push(table);
    }
    return out;
  }

  // The declared type each output column would get in CREATE TABLE ... AS.
  // Only a column reference or a CAST has one; every other expression gets "".
  affinities(sql: string): Map<string, string> {
    const name = `_solarsql_probe_${Math.random().toString(36).slice(2)}`;
    // The statement is wrapped, so its own LIMIT and ORDER BY stay valid.
    // Parameters bind as NULL, which is fine for a probe that reads no row.
    this.db.exec(`create temp table ${quoteIdent(name)} as select * from (${sql}) limit 0`);
    try {
      const rows = this.db.prepare(`pragma table_xinfo(${quoteIdent(name)})`).all() as { name: string; type: string }[];
      return new Map(rows.map((r) => [r.name, r.type]));
    } finally {
      this.db.exec(`drop table ${quoteIdent(name)}`);
    }
  }

  // Every table access a statement makes, from setAuthorizer() at prepare.
  accesses(sql: string): Access[] {
    const out: Access[] = [];
    const c = constants;
    this.db.setAuthorizer((code: number, a1: string | null, a2: string | null, _db: string | null, via: string | null) => {
      const action =
        code === c.SQLITE_READ ? "read" :
        code === c.SQLITE_INSERT ? "insert" :
        code === c.SQLITE_UPDATE ? "update" :
        code === c.SQLITE_DELETE ? "delete" :
        code === c.SQLITE_FUNCTION ? "function" : "other";
      if (action === "read" || action === "insert" || action === "update" || action === "delete") {
        out.push({ action, table: a1, column: action === "read" || action === "update" ? a2 : null, via });
      } else if (action === "function") {
        out.push({ action, table: null, column: a2, via });
      }
      return c.SQLITE_OK;
    });
    try {
      this.db.prepare(sql);
    } finally {
      this.db.setAuthorizer(null);
    }
    return out;
  }
}

// The literals of `check (<column> in ('a', 'b'))` or `check (<column> in
// (0, 1))` inside one column definition. The definition text is normalized
// by scan.ts.
function oneOfLiterals(definition: string, column: string): (string | number)[] | null {
  const lower = normalize(definition);
  const key = `check(${column.toLowerCase()} in(`;
  const at = lower.indexOf(key);
  if (at === -1) return null;
  const rest = lower.slice(at + key.length);
  const close = rest.indexOf(")");
  if (close === -1) return null;
  const literals: (string | number)[] = [];
  for (const t of tokenize(rest.slice(0, close))) {
    if (t.type === "string") literals.push(t.text.slice(1, -1).replace(/''/g, "'"));
    else if (t.type === "number") literals.push(Number(t.text));
    else if (t.type !== "ws" && t.text !== ",") return null;
  }
  return literals.length > 0 ? literals : null;
}
