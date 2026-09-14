// Responsibility: the facts about SQL that come from the engine.
// A node:sqlite connection holds the declared or existing schema. Every
// question below is answered by preparing a statement in it: column origins,
// declared types, nullability, foreign keys, the nullable side of a join,
// the affinity of an expression, and the tables a statement touches.
// Boundary: nothing here reads SQL text beyond what scan.ts provides. Nothing
// here produces TypeScript; typegen.ts does that from these facts.
import { DatabaseSync, constants } from "node:sqlite";
import { aliasMap, cteNames, definitions, isKeyword, quoteIdent, significant, tokenize, unquote } from "./scan.ts";

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
  // A hidden column of a virtual table: the match target named after the
  // table, and `rank`.
  hidden: boolean;
};

// `to` is null when the REFERENCES clause omits its column list; SQLite
// then resolves the parent key to the target table's own primary key.
export type ForeignKeyFact = { table: string; from: string; to: string | null };

export type TableFact = {
  name: string;
  sql: string;
  // A CREATE VIRTUAL TABLE (a full-text search table). No STRICT, no
  // primary key, every column untyped.
  virtual: boolean;
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
  // The engine owns the supplied connection, including a read-only source.
  constructor(statements: readonly string[], database?: DatabaseSync) {
    this.db = database ?? new DatabaseSync(":memory:");
    for (const s of statements) {
      try {
        this.db.exec(s);
      } catch (e) {
        this.db.close();
        throw new Error(`${(e as Error).message}\n  in: ${s.replace(/\s+/g, " ").trim()}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // The tables and the virtual tables. The shadow tables a virtual table
  // keeps for itself are left out.
  tables(): TableFact[] {
    const rows = this.db
      .prepare(
        `select s.name, s.sql from sqlite_schema s join pragma_table_list l on l.name = s.name and l.schema = 'main'
         where s.type = 'table' and s.sql is not null and lower(s.name) not glob 'sqlite_*' and l.type <> 'shadow' order by s.name`,
      )
      .all() as { name: string; sql: string }[];
    return rows.map((r) => this.table(r.name, r.sql));
  }

  table(name: string, sql?: string): TableFact {
    const ddl = sql ?? (this.db.prepare(`select sql from sqlite_schema where type = 'table' and name = ?`).get(name) as { sql: string } | undefined)?.sql;
    if (!ddl) throw new Error(`no table named ${name}`);
    const defs = definitions(ddl);
    // SQLite metadata describes the parsed table; trailing comments can name
    // STRICT or WITHOUT ROWID without enabling either attribute.
    const attributes = this.db.prepare(`select type, wr, strict from pragma_table_list where schema = 'main' and name = ?`).get(name) as { type: string; wr: number; strict: number };
    const virtual = attributes.type === "virtual";
    // hidden: 0 is a plain column, 2 a virtual generated column, 3 a stored
    // one. 1 is a hidden column of a virtual table, which a query may read.
    const columns = (this.db.prepare(`select name, type, "notnull" as nn, dflt_value, pk, hidden from pragma_table_xinfo(?) where hidden in (0, 2, 3) or (hidden = 1 and ?)`).all(name, virtual ? 1 : 0) as {
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
      generated: c.hidden === 2 || c.hidden === 3,
      hidden: c.hidden === 1,
    }));
    const foreignKeys = (this.db.prepare(`select "table", "from", "to" from pragma_foreign_key_list(?) order by id, seq`).all(name) as { table: string; from: string; to: string | null }[]).map((f) => ({
      table: f.table,
      from: f.from,
      to: f.to,
    }));
    return { name, sql: ddl, virtual, columns, foreignKeys, withoutRowid: attributes.wr === 1, strict: attributes.strict === 1 };
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

  view(name: string): { sql: string; columns: string[] } | null {
    const row = this.db.prepare("select sql from sqlite_schema where type = 'view' and name = ? collate nocase").get(name) as { sql: string } | undefined;
    if (!row) return null;
    const as = tokenize(row.sql).find((token) => token.depth === 0 && token.type === "ident" && token.text.toLowerCase() === "as");
    if (!as) return null;
    return { sql: row.sql.slice(as.end), columns: this.columns(`select * from ${quoteIdent(name)}`).map((column) => column.name) };
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
    // The plan names the alias; the text maps it back to the table. A CTE
    // reference or a derived table's alias is not a real table, and must
    // not be reported as one.
    const aliases = aliasMap(sql);
    const ctes = cteNames(sql);
    const out: string[] = [];
    for (const r of this.db.prepare(`explain query plan ${sql}`).all()) {
      const detail = (r as { detail: string }).detail;
      // json_each is a parameter, and a scan of it is its only plan.
      if (detail.includes("VIRTUAL TABLE")) continue;
      // A scan through an index, covering or not, still visits every row.
      const m = /^SCAN\s+(\S+)(?:\s+USING\s+(?:COVERING\s+)?INDEX\s+\S+)?$/.exec(detail);
      if (!m) continue;
      const alias = unquote(m[1]!);
      if (ctes.has(alias)) continue;
      const table = aliases.has(alias) ? aliases.get(alias)! : alias;
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

// Only a complete IN check bounds the domain. OR and permissive collations
// can admit values beyond the listed literals; punctuation inside text is data.
function oneOfLiterals(definition: string, column: string): (string | number)[] | null {
  const tokens = significant(tokenize(definition));
  if (tokens.some((t, i) => isKeyword(t, "collate") && unquote(tokens[i + 1]?.text ?? "").toLowerCase() !== "binary")) return null;
  for (let i = 0; i < tokens.length; i++) {
    if (!isKeyword(tokens[i]!, "check") || tokens[i]!.depth !== 0 || tokens[i + 1]?.text !== "(") continue;
    const end = tokens.findIndex((t, j) => j > i + 1 && t.text === ")" && t.depth === 0);
    if (end < 0) continue;
    const expression = tokens.slice(i + 2, end);
    if (expression[0]?.type !== "ident" || unquote(expression[0].text).toLowerCase() !== column.toLowerCase()
      || !expression[1] || !isKeyword(expression[1], "in") || expression[2]?.text !== "("
      || expression.at(-1)?.text !== ")" || expression.at(-1)?.depth !== 1) continue;
    const list = expression.slice(3, -1);
    const literals: (string | number)[] = [];
    let valid = true;
    for (let j = 0; j < list.length; j++) {
      let t = list[j]!;
      let sign = 1;
      if (t.text === "+" || t.text === "-") {
        sign = t.text === "-" ? -1 : 1;
        t = list[++j]!;
        if (t?.type !== "number") { valid = false; break; }
      }
      if (t?.type === "string") literals.push(t.text.slice(1, -1).replace(/''/g, "'"));
      else if (t?.type === "number") {
        const value = sign * Number(t.text);
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) { valid = false; break; }
        literals.push(value);
      } else { valid = false; break; }
      if (j + 1 < list.length && (list[++j]!.text !== "," || j + 1 === list.length)) { valid = false; break; }
    }
    if (valid && literals.length) return literals;
  }
  return null;
}
