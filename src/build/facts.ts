// Responsibility: the facts about SQL that come from the engine.
// A node:sqlite connection holds the declared or existing schema. Every
// question below is answered by preparing a statement in it: column origins,
// declared types, nullability, foreign keys, the nullable side of a join,
// the affinity of an expression, and the tables a statement touches.
// Boundary: nothing here reads SQL text beyond what scan.ts provides. Nothing
// here produces TypeScript; typegen.ts does that from these facts.
import { DatabaseSync, constants } from "node:sqlite";
import { aliasCandidates, cteNames, definitions, isKeyword, quoteIdent, significant, tokenize, type Token, unquote } from "./scan.ts";

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

// One row of `EXPLAIN QUERY PLAN`, https://sqlite.org/eqp.html: `id` names
// the row, `parent` its enclosing row (0 for a top-level one, so a CTE or a
// subquery keeps its own rows nested under it), `detail` the plan text a
// SCAN, a SEARCH, or a "USE TEMP B-TREE FOR ..." line. The fourth column
// SQLite returns, `notused`, carries no documented meaning and is dropped.
export type PlanRow = { id: number; parent: number; detail: string };

export type Access = {
  action: "read" | "insert" | "update" | "delete" | "function" | "other";
  table: string | null;
  column: string | null;
  // The view or trigger that caused the access, when the access is indirect.
  via: string | null;
};

// D1 and a Durable Object's own storage both run on workerd's SQLite, which
// refuses SQLITE_FUNCTION at prepare for any name outside this set (an
// operator like `like` or `->>` is reported as a function too). node:sqlite
// has no such restriction, so a query built and typechecked locally can
// still fail on every call at either deploy target unless this list also
// gates the three sites that run text a user wrote: Engine.prepare(), the
// Engine constructor's own DDL loop (a CHECK, VIEW, or TRIGGER body is SQL
// too), and migration.ts's applied(), a second DDL entry point outside this
// class (see withDeniedFunctions below; ADR 0113, ADR 0114). The build's own
// internal SQL -- accesses(), columns(), fullScans(), plan(), affinities(),
// and a diagnostic `select sqlite_version()` -- is unaffected by design (see
// Engine.prepare()'s own comment for why).
// Copied verbatim from cloudflare/workerd's ALLOWED_SQLITE_FUNCTIONS,
// src/workerd/util/sqlite.c++, commit c240f0e, lines 380-543. workerd
// compares case-insensitively (its own comment: SQLite's own convention for
// identifiers is sqlite3_stricmp, and workerd instead lowercases both sides
// once per prepare); the comparison here does the same. Five names workerd
// itself comments out of that array on purpose ("These functions query
// SQLite internals and build details in a way we'd prefer not to reveal.")
// are left out here too: sqlite_compileoption_get, sqlite_compileoption_used,
// sqlite_offset, sqlite_source_id, sqlite_version.
const ALLOWED_SQLITE_FUNCTIONS = new Set([
  // https://www.sqlite.org/lang_corefunc.html
  "abs", "changes", "char", "coalesce", "concat", "concat_ws", "format", "glob", "hex", "ifnull", "iif", "instr",
  "last_insert_rowid", "length", "like", "likelihood", "likely", "load_extension", "lower", "ltrim", "max_scalar",
  "min_scalar", "nullif", "octet_length", "printf", "quote", "random", "randomblob", "replace", "round", "rtrim",
  "sign", "soundex", "substr", "substring", "total_changes", "trim", "typeof", "unhex", "unicode", "unlikely",
  "upper", "zeroblob",
  // https://www.sqlite.org/lang_datefunc.html
  "date", "time", "datetime", "julianday", "unixepoch", "strftime", "timediff", "current_date", "current_time",
  "current_timestamp",
  // https://www.sqlite.org/lang_aggfunc.html
  "avg", "count", "group_concat", "max", "min", "string_agg", "sum", "total",
  // https://www.sqlite.org/windowfunctions.html#biwinfunc
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value",
  "last_value", "nth_value",
  // https://www.sqlite.org/lang_mathfunc.html
  "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "ceil", "cos", "cosh", "degrees", "exp", "floor",
  "ln", "log", "log2", "mod", "pi", "pow", "radians", "sin", "sinh", "sqrt", "tan", "tanh", "trunc",
  // https://www.sqlite.org/json1.html
  "json", "jsonb", "json_array", "jsonb_array", "json_array_length", "json_extract", "jsonb_extract", "->", "->>",
  "json_insert", "jsonb_insert", "json_object", "jsonb_object", "json_patch", "jsonb_patch", "json_remove",
  "jsonb_remove", "json_replace", "jsonb_replace", "json_set", "jsonb_set", "json_type", "json_valid", "json_quote",
  "json_group_array", "jsonb_group_array", "json_group_object", "jsonb_group_object", "json_each", "json_tree",
  // https://www.sqlite.org/fts5.html
  "match", "highlight", "bm25", "snippet",
  // https://www.sqlite.org/rtree.html
  "rtreecheck",
  // https://www.sqlite.org/lang_altertable.html
  "sqlite_rename_column", "sqlite_rename_table", "sqlite_rename_test", "sqlite_drop_column",
  "sqlite_rename_quotefix",
]);

// Sets the allowlist's deny authorizer on `db` for the duration of `fn`
// only, then clears it in a `finally`, whatever `fn` does -- the call-scoped
// shape ADR 0113 established for Engine.prepare(), factored out so the
// Engine constructor's DDL loop and migration.ts's applied() replay (a
// second, build-external DDL entry point) can gate the same allowlist
// without a connection-level authorizer (see Engine.prepare()'s own comment
// for why connection-level was rejected).
export function withDeniedFunctions<T>(db: DatabaseSync, fn: () => T): T {
  db.setAuthorizer((code: number, _a1: string | null, a2: string | null) =>
    code === constants.SQLITE_FUNCTION && !ALLOWED_SQLITE_FUNCTIONS.has((a2 ?? "").toLowerCase())
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    return fn();
  } finally {
    db.setAuthorizer(null);
  }
}

export class Engine {
  readonly db: DatabaseSync;

  // A statement the engine refuses is reported with its text, so a bad
  // trigger body or view names itself.
  // The engine owns the supplied connection, including a read-only source.
  // Each statement runs through withDeniedFunctions, inside this loop's own
  // per-statement try/catch: a CREATE TABLE's CHECK expression is compiled
  // and resolved once, at this CREATE, and never reconsidered by a later
  // INSERT or UPDATE, so this is the only point in the build where a CHECK
  // constraint's own function call is ever checked (ADR 0114).
  constructor(statements: readonly string[], database?: DatabaseSync) {
    this.db = database ?? new DatabaseSync(":memory:");
    for (const s of statements) {
      try {
        withDeniedFunctions(this.db, () => this.db.exec(s));
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

  // Preparing alone finds syntax errors and unknown names. The authorizer is
  // scoped to this one prepare, not the connection, so it denies only the
  // query or plan item under analysis: a permanent connection-level
  // authorizer would also reach the build's own internal diagnostic
  // `select sqlite_version()` calls (analyze.ts, build.ts), which go through
  // this.db.prepare() directly and must keep working. The constructor scopes
  // its own deny authorizer the same way, once per DDL statement it runs, so
  // a CHECK constraint's function call is denied at CREATE the same way this
  // method denies one in a query (ADR 0114).
  prepare(sql: string): void {
    withDeniedFunctions(this.db, () => this.db.prepare(sql));
  }

  view(name: string): { sql: string; columns: string[] } | null {
    const row = this.db.prepare("select sql from sqlite_schema where type = 'view' and name = ? collate nocase").get(name) as { sql: string } | undefined;
    if (!row) return null;
    const as = tokenize(row.sql).find((token) => token.depth === 0 && token.type === "ident" && token.text.toLowerCase() === "as");
    if (!as) return null;
    return { sql: row.sql.slice(as.end), columns: this.columns(`select * from ${quoteIdent(name)}`).map((column) => column.name) };
  }

  // Tables the plan reads in full (`SCAN t`), by table name. An optional
  // filter written as `(:p is null or col = :p)` disables the index, and
  // this is how the build tells the agent.
  fullScans(sql: string): string[] {
    // The plan names the alias; the text maps it back to every table that
    // alias could mean (aliasCandidates), because a reused alias's SCAN
    // line names only one of them. Reporting every candidate unconditionally
    // would flag an already-indexed table as a false positive whenever a
    // *different* plan line resolves the same alias through a named index
    // (see the index-resolution pass below); a CTE reference or a derived
    // table's alias is not a real table either way, and must not be
    // reported as one.
    const aliases = aliasCandidates(sql);
    const ctes = cteNames(sql);
    const rows = this.db.prepare(`explain query plan ${sql}`).all() as { detail: string }[];
    const indexToTable = this.db.prepare(`select tbl_name from sqlite_schema where type = 'index' and name = ?`);

    // A WITHOUT ROWID table's primary-key search, and a true rowid-alias
    // table's INTEGER PRIMARY KEY search, name no index at all: SQLite has
    // no sqlite_schema index object for either access path, so
    // indexToTable above can never resolve them. Each access path is still
    // shape-specific to the tables that have it, so it resolves an alias on
    // its own when exactly one of the alias's candidates has that shape.
    const tableListWr = this.db.prepare(`select wr from pragma_table_list where schema = 'main' and name = ?`);
    const pkColumns = this.db.prepare(`select type from pragma_table_info(?) where pk > 0`);
    const pkNamedIndex = this.db.prepare(`select 1 from pragma_index_list(?) where origin = 'pk'`);
    const withoutRowid = (table: string): boolean => (tableListWr.get(table) as { wr: number } | undefined)?.wr === 1;
    // The same condition migration.ts uses for its own rowidAlias field: a
    // lone INTEGER primary-key column is not enough on its own, because
    // `integer primary key desc` matches it too while still getting its own
    // named sqlite_autoindex (and so already resolves through indexToTable).
    // Only the absence of a pragma_index_list 'pk' entry rules that out.
    const rowidAlias = (table: string): boolean => {
      if (withoutRowid(table)) return false;
      const pk = pkColumns.all(table) as { type: string }[];
      if (pk.length !== 1 || pk[0]!.type.toUpperCase() !== "INTEGER") return false;
      return !pkNamedIndex.get(table);
    };

    // For every SCAN or SEARCH line, the alias it names and, when the line
    // resolves to one table, that table. An index name is unambiguous
    // (sqlite_schema has at most one index per name), so a named "USING ...
    // INDEX" clause resolves the alias for that line's table without
    // needing aliasCandidates at all. Failing that, an unnamed
    // "USING PRIMARY KEY" or "USING INTEGER PRIMARY KEY" line still
    // resolves the alias when its own shape (withoutRowid or rowidAlias,
    // respectively) matches exactly one candidate. Two or more matching
    // candidates leaves this ambiguous on purpose: nothing here
    // disambiguates between two WITHOUT ROWID (or two rowid-alias) tables
    // sharing one alias, and the fallback below already covers that case by
    // not subtracting. A line resolving to null contributes nothing below
    // -- the fallback is to leave the ambiguous alias's candidates
    // untouched, never to drop a genuine scan because one line's table
    // couldn't be named.
    const resolved = rows.map((r) => {
      const alias = /^(?:SCAN|SEARCH)\s+(\S+)/.exec(r.detail)?.[1];
      if (!alias) return { alias: "", table: null as string | null };
      const aliasName = unquote(alias);
      const index = /USING\s+(?:COVERING\s+)?INDEX\s+(\S+)/.exec(r.detail)?.[1];
      if (index) {
        const row = indexToTable.get(unquote(index)) as { tbl_name: string } | undefined;
        return { alias: aliasName, table: row?.tbl_name ?? null };
      }
      // A trailing qualifier word ("EXISTS", "LEFT-JOIN") can sit between
      // the alias and "USING" on a SEARCH line too, so the match must not
      // anchor "USING" right after the alias.
      const candidates = [...(aliases.get(aliasName) ?? [])].filter((t): t is string => t !== null);
      if (r.detail.startsWith("SEARCH ") && /\bUSING\s+PRIMARY\s+KEY\b/.test(r.detail)) {
        const matches = candidates.filter(withoutRowid);
        if (matches.length === 1) return { alias: aliasName, table: matches[0]! };
      } else if (r.detail.startsWith("SEARCH ") && /\bUSING\s+INTEGER\s+PRIMARY\s+KEY\b/.test(r.detail)) {
        const matches = candidates.filter(rowidAlias);
        if (matches.length === 1) return { alias: aliasName, table: matches[0]! };
      }
      return { alias: aliasName, table: null };
    });

    const out: string[] = [];
    rows.forEach((r, i) => {
      const detail = r.detail;
      // json_each is a parameter, and a scan of it is its only plan.
      if (detail.includes("VIRTUAL TABLE")) return;
      // A scan through an index, covering or not, still visits every row.
      // SQLite appends a trailing qualifier word to some SCAN lines --
      // "EXISTS" for a correlated subquery's scan, "LEFT-JOIN" for an outer
      // join's null-producing side, either bare or after the USING INDEX
      // clause -- so the match must not anchor the end of the line to the
      // alias or to that clause. Anchoring there is what silently dropped a
      // genuine full scan inside a LEFT JOIN or an EXISTS subquery.
      const m = /^SCAN\s+(\S+)(?:\s+USING\s+(?:COVERING\s+)?INDEX\s+\S+)?(?:\s+.+)?$/.exec(detail);
      if (!m) return;
      const alias = unquote(m[1]!);
      if (ctes.has(alias)) return;
      // A synthetic scan like "SCAN 2 CONSTANT ROWS" (from a VALUES/CTE
      // construct) captures a candidate that is not a real alias. Relying on
      // aliases.has() rather than a whitelist of known trailing qualifiers
      // keeps this correct even if SQLite adds a qualifier this code does
      // not know about; a candidate not in the alias map is skipped instead
      // of reported as a table named after itself.
      if (!aliases.has(alias)) return;
      // Start from every table this alias could mean, then subtract the
      // ones a *different* plan line already placed with a named index --
      // that line's own USING INDEX clause proves the alias meant that
      // table there, not this SCAN's table. The set is cloned per line
      // (aliasCandidates shares one Set per alias) so that resolving one
      // SCAN line never removes a candidate a sibling SCAN line still needs.
      // "j !== i" excludes this line's own resolution: this SCAN can carry
      // a USING INDEX clause too (an index walked for ORDER BY still scans
      // every row), and that must not cancel the very table it reports.
      const candidates = new Set(aliases.get(alias)!);
      for (let j = 0; j < resolved.length; j++) {
        if (j === i) continue;
        const other = resolved[j]!;
        if (other.alias === alias && other.table) candidates.delete(other.table);
      }
      // Every candidate can be subtracted -- the same alias, and the same
      // single table, declared twice (an outer SEARCH and an inner EXISTS
      // SCAN, say). Then this SCAN's own table was necessarily one of the
      // ones "placed elsewhere", so subtracting was wrong for this line;
      // restore the full set rather than silently report nothing.
      if (![...candidates].some((table) => table !== null)) {
        for (const table of aliases.get(alias)!) candidates.add(table);
      }
      for (const table of candidates) {
        if (table && !out.includes(table)) out.push(table);
      }
    });
    return out;
  }

  // `EXPLAIN QUERY PLAN <sql>` as SQLite returns it, https://sqlite.org/eqp.html.
  // build.ts derives an operation's SEARCH/SCAN/temp-B-tree summary from
  // `detail`'s grammar (also documented there); this method only shapes the
  // raw rows, the same way fullScans() above reads them for its own purpose.
  plan(sql: string): PlanRow[] {
    return (this.db.prepare(`explain query plan ${sql}`).all() as { id: number; parent: number; detail: string }[]).map((r) => ({
      id: r.id,
      parent: r.parent,
      detail: r.detail,
    }));
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

// A CHECK predicate of the form `<in-list> OR <column> IS NULL`, in
// either order, admits nothing the bare IN list doesn't already admit:
// SQLite passes any CHECK whose result is NULL, whatever the predicate
// says, so this one disjunct can be dropped before the exact-match check
// below. Any other OR is left alone (ADR 0097).
function stripRedundantIsNull(expression: readonly Token[], column: string): readonly Token[] {
  const isNullClause = (a: Token | undefined, b: Token | undefined, c: Token | undefined): boolean =>
    a?.type === "ident" && a.depth === 1 && unquote(a.text).toLowerCase() === column.toLowerCase()
    && isKeyword(b, "is") && b!.depth === 1 && isKeyword(c, "null") && c!.depth === 1;
  if (expression.length > 4 && isKeyword(expression.at(-4), "or") && expression.at(-4)!.depth === 1
    && isNullClause(expression.at(-3), expression.at(-2), expression.at(-1))) {
    return expression.slice(0, -4);
  }
  if (expression.length > 4 && isNullClause(expression[0], expression[1], expression[2])
    && isKeyword(expression[3], "or") && expression[3]!.depth === 1) {
    return expression.slice(4);
  }
  return expression;
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
    const expression = stripRedundantIsNull(tokens.slice(i + 2, end), column);
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
