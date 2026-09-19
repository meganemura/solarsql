// Responsibility: the facts about SQL that come from its text alone.
// A tokenizer splits SQL into tokens without a grammar. The helpers below
// read the token stream for a fixed set of shapes: named parameters, the
// items of a select list, the arguments of a call, the aliases of FROM and
// JOIN, the column definitions of CREATE TABLE, and the statements of a file.
// Boundary: no SQL grammar lives here. A shape outside the fixed set gives
// null, and the caller reports it. Every other fact comes from the engine
// (see facts.ts).

export type TokenType = "ident" | "string" | "number" | "param" | "punct" | "ws" | "comment";

export type Token = {
  type: TokenType;
  // The exact source text, so that joining every token gives the input back.
  text: string;
  start: number;
  end: number;
  // Parenthesis depth before this token. A "(" has the depth outside it.
  depth: number;
};

// A separator belongs between digits. Keep the complete spelling so source
// spans and names remain SQLite's, including hexadecimal and exponent forms.
const numericLiteral = /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/;

const punct2 = new Set(["<>", "!=", "<=", ">=", "||", "->", "->>"]);

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let depth = 0;
  const push = (type: TokenType, end: number) => {
    out.push({ type, text: sql.slice(i, end), start: i, end, depth });
    i = end;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql[j]!)) j++;
      push("ws", j);
      continue;
    }
    if (sql.startsWith("--", i)) {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = sql.length;
      push("comment", j);
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let j = sql.indexOf("*/", i + 2);
      j = j === -1 ? sql.length : j + 2;
      push("comment", j);
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        const q = sql.indexOf("'", j);
        if (q === -1) {
          j = sql.length;
          break;
        }
        if (sql[q + 1] === "'") {
          j = q + 2;
          continue;
        }
        j = q + 1;
        break;
      }
      push("string", j);
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (;;) {
        const q = sql.indexOf(close, j);
        if (q === -1) {
          j = sql.length;
          break;
        }
        if (close !== "]" && sql[q + 1] === close) {
          j = q + 2;
          continue;
        }
        j = q + 1;
        break;
      }
      push("ident", j);
      continue;
    }
    if (ch === ":" || ch === "@" || ch === "$") {
      // SQLite permits digit and Unicode names, namespace separators, and
      // a parenthesized suffix. Keep each engine slot as one token.
      let end = i + 1, letters = 0;
      while (end < sql.length) {
        if (/[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[end]!)) { letters++; end++; }
        else if (sql.slice(end, end + 2) === "::") end += 2;
        else if (sql[end] === "(" && letters > 0) {
          end++;
          while (end < sql.length && !/[\t\n\f\r )]/.test(sql[end]!)) end++;
          if (sql[end] === ")") end++;
          break;
        } else break;
      }
      if (letters > 0) {
        push("param", end);
        continue;
      }
    }
    if (ch === "?") {
      const m = /^\?[0-9]*/.exec(sql.slice(i))!;
      push("param", i + m[0].length);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const m = numericLiteral.exec(sql.slice(i))!;
      push("number", i + m[0].length);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      push("ident", i + m[0].length);
      continue;
    }
    if (ch === "(") {
      push("punct", i + 1);
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      out.push({ type: "punct", text: ")", start: i, end: i + 1, depth });
      i++;
      continue;
    }
    const three = sql.slice(i, i + 3);
    const two = sql.slice(i, i + 2);
    if (three.length === 3 && punct2.has(three)) {
      push("punct", i + 3);
      continue;
    }
    if (two.length === 2 && punct2.has(two)) {
      push("punct", i + 2);
      continue;
    }
    push("punct", i + 1);
  }
  return out;
}

// Tokens that carry meaning: no whitespace, no comments.
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== "ws" && t.type !== "comment");
}

export function isKeyword(token: Token | undefined, word: string): boolean {
  return token !== undefined && token.type === "ident" && token.text.toLowerCase() === word;
}

// Named parameters in order of first appearance, which is the order SQLite
// numbers them. Anonymous "?" and numbered "?NNN" parameters are rejected,
// because a name is what the generated types are keyed on.
export function namedSlots(sql: string): { sqlName: string; key: string }[] {
  const names = [...new Set(tokenize(sql).filter(t => t.type === "param" && !t.text.startsWith("?")).map(t => t.text))];
  const slots = names.map(sqlName => ({ sqlName, key: sqlName.slice(1) }));
  // A bare name can itself start with '$'. Promotion must also resolve
  // collisions between that name and another slot's qualified key.
  for (;;) {
    const duplicate = new Set(slots.filter(slot => slots.filter(other => other.key === slot.key).length > 1).map(slot => slot.key));
    if (duplicate.size === 0) return slots;
    for (const slot of slots) if (duplicate.has(slot.key)) slot.key = slot.sqlName;
  }
}

export function namedParams(sql: string): { names: string[]; anonymous: Token[] } {
  return { names: namedSlots(sql).map(slot => slot.key), anonymous: tokenize(sql).filter(t => t.type === "param" && t.text.startsWith("?")) };
}

// The documentation of a statement: its leading "--" comment lines.
export function leadingComment(sql: string): string {
  const lines: string[] = [];
  for (const t of tokenize(sql)) {
    if (t.type === "ws") continue;
    if (t.type === "comment" && t.text.startsWith("--")) {
      lines.push(t.text.slice(2).trim());
      continue;
    }
    break;
  }
  return lines.join("\n");
}

export function unquote(token: string): string {
  const m = /^"((?:[^"]|"")*)"$|^`((?:[^`]|``)*)`$|^\[([^\]]*)\]$/.exec(token);
  if (!m) return token;
  return (m[1] ?? m[2] ?? m[3] ?? "").replace(/""/g, '"').replace(/``/g, "`");
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function normalize(text: string): string {
  let result = "";
  let space = false;
  let previous = "";
  for (const token of tokenize(text)) {
    if (token.type === "ws" || token.type === "comment") {
      space = true;
      continue;
    }
    // SQL literals and quoted names retain their bytes. Only token boundaries
    // can lose whitespace without changing a CHECK, default, or object name.
    const punctuation = token.type === "punct" ? token.text : "";
    if (space && result && !["(", ",", ")"].includes(punctuation) && previous !== "(" && previous !== ",") result += " ";
    result += token.type === "ident" && !/^["`[]/.test(token.text) ? token.text.toLowerCase() : token.text;
    previous = punctuation;
    space = false;
  }
  return result;
}

// The name a CREATE statement creates, and what kind of object it is. A
// CREATE VIRTUAL TABLE is "virtual".
export function created(sql: string): { kind: "table" | "index" | "trigger" | "view" | "virtual"; name: string } | null {
  const t = significant(tokenize(sql));
  if (!isKeyword(t[0], "create")) return null;
  let i = 1;
  if (isKeyword(t[i], "unique") || isKeyword(t[i], "temp") || isKeyword(t[i], "temporary")) i++;
  let kind = t[i]?.text.toLowerCase();
  if (kind === "virtual" && isKeyword(t[i + 1], "table")) {
    i++;
  } else if (kind !== "table" && kind !== "index" && kind !== "trigger" && kind !== "view") return null;
  if (kind === "virtual") kind = "virtual";
  i++;
  if (isKeyword(t[i], "if") && isKeyword(t[i + 1], "not") && isKeyword(t[i + 2], "exists")) i += 3;
  const name = t[i];
  if (!name || name.type !== "ident") return null;
  return { kind: kind as "table" | "index" | "trigger" | "view" | "virtual", name: unquote(name.text) };
}

// A column rename, distinguished from `ALTER TABLE ... RENAME TO
// <table>` (which renames the table itself, not a column) by whether
// "RENAME" is immediately followed by "TO" or by a column name.
export function renamedColumn(sql: string): { table: string; from: string; to: string } | null {
  const t = significant(tokenize(sql));
  if (!isKeyword(t[0], "alter") || !isKeyword(t[1], "table")) return null;
  const tableToken = t[2];
  if (!tableToken || tableToken.type !== "ident") return null;
  if (!isKeyword(t[3], "rename")) return null;
  let i = 4;
  if (isKeyword(t[i], "to")) return null;
  if (isKeyword(t[i], "column")) i++;
  const from = t[i];
  if (!from || from.type !== "ident") return null;
  if (!isKeyword(t[i + 1], "to")) return null;
  const to = t[i + 2];
  if (!to || to.type !== "ident") return null;
  return { table: unquote(tableToken.text), from: unquote(from.text), to: unquote(to.text) };
}

// The name and the table of a CREATE INDEX statement, else null.
export function indexTarget(sql: string): { name: string; table: string } | null {
  const t = significant(tokenize(sql));
  const c = created(sql);
  if (!c || c.kind !== "index") return null;
  let i = t.findIndex((tok) => tok.type === "ident" && unquote(tok.text) === c.name && tok.depth === 0) + 1;
  if (i === 0 || !isKeyword(t[i], "on")) return null;
  const table = t[i + 1];
  if (!table || table.type !== "ident") return null;
  return { name: c.name, table: unquote(table.text) };
}

// The name, the event, the columns of `update of c1, c2`, and the table of a
// CREATE TRIGGER statement, else null.
export function triggerTarget(sql: string): { name: string; event: "insert" | "update" | "delete"; columns: string[]; table: string } | null {
  const t = significant(tokenize(sql));
  const c = created(sql);
  if (!c || c.kind !== "trigger") return null;
  let i = t.findIndex((tok) => tok.type === "ident" && unquote(tok.text) === c.name && tok.depth === 0) + 1;
  if (i === 0) return null;
  if (isKeyword(t[i], "before") || isKeyword(t[i], "after")) i++;
  else if (isKeyword(t[i], "instead") && isKeyword(t[i + 1], "of")) i += 2;
  const eventTok = t[i];
  if (!eventTok) return null;
  const event = eventTok.text.toLowerCase();
  if (event !== "insert" && event !== "update" && event !== "delete") return null;
  i++;
  const columns: string[] = [];
  if (event === "update" && isKeyword(t[i], "of")) {
    i++;
    while (t[i] && !isKeyword(t[i], "on")) {
      if (t[i]!.type === "ident") columns.push(unquote(t[i]!.text));
      i++;
    }
  }
  while (t[i] && !isKeyword(t[i], "on")) i++;
  const table = t[i + 1];
  if (!table || table.type !== "ident") return null;
  return { name: c.name, event, columns, table: unquote(table.text) };
}

// Split a token range at top-level commas (depth equal to the depth of the
// first token). Returns the text of each item with its span.
export function splitAtCommas(sql: string, tokens: Token[], from: number, to: number): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const base = tokens[from]?.depth ?? 0;
  let start = tokens[from]?.start ?? 0;
  for (let i = from; i < to; i++) {
    const t = tokens[i]!;
    if (t.type === "punct" && t.text === "," && t.depth === base) {
      out.push({ text: sql.slice(start, t.start).trim(), start, end: t.start });
      start = t.end;
    }
  }
  const end = tokens[to - 1]?.end ?? start;
  if (sql.slice(start, end).trim().length > 0) out.push({ text: sql.slice(start, end).trim(), start, end });
  return out;
}

// The argument list of the first call `name(` at or after `from`.
export function findCall(sql: string, name: string, from = 0): { open: number; close: number; args: { text: string; start: number; end: number }[] } | null {
  const all = tokenize(sql);
  for (let i = 0; i < all.length; i++) {
    const t = all[i]!;
    if (t.start < from || !isKeyword(t, name)) continue;
    let j = i + 1;
    while (all[j] && (all[j]!.type === "ws" || all[j]!.type === "comment")) j++;
    const open = all[j];
    if (!open || open.text !== "(") continue;
    let k = j + 1;
    while (all[k] && !(all[k]!.type === "punct" && all[k]!.text === ")" && all[k]!.depth === open.depth)) k++;
    const close = all[k];
    if (!close) return null;
    return { open: open.start, close: close.start, args: splitAtCommas(sql, all, j + 1, k) };
  }
  return null;
}

// The items of the outermost select list, in order, with their spans and
// their output alias when one is written. Null when the statement is not a
// select at depth zero (an insert, a compound select, a CTE-only text).
export function selectItems(sql: string): { text: string; start: number; end: number; expr: string; alias: string | null }[] | null {
  const all = tokenize(sql);
  let selectAt = -1;
  let fromAt = -1;
  for (let i = 0; i < all.length; i++) {
    const t = all[i]!;
    if (t.depth !== 0 || t.type !== "ident") continue;
    if (selectAt === -1 && isKeyword(t, "select")) {
      selectAt = i;
      continue;
    }
    if (selectAt !== -1 && (isKeyword(t, "from") || isKeyword(t, "where") || isKeyword(t, "group") || isKeyword(t, "order") || isKeyword(t, "limit") || isKeyword(t, "union") || isKeyword(t, "except") || isKeyword(t, "intersect"))) {
      fromAt = i;
      break;
    }
  }
  if (selectAt === -1) return null;
  let first = selectAt + 1;
  while (all[first] && (all[first]!.type === "ws" || all[first]!.type === "comment")) first++;
  if (isKeyword(all[first], "distinct") || isKeyword(all[first], "all")) first++;
  const to = fromAt === -1 ? all.length : fromAt;
  return splitAtCommas(sql, all, first, to).map((item) => {
    const toks = significant(tokenize(item.text));
    const last = toks[toks.length - 1];
    const beforeLast = toks[toks.length - 2];
    if (last && last.type === "ident" && isKeyword(beforeLast, "as")) {
      const exprEnd = beforeLast!.start;
      return { ...item, expr: item.text.slice(0, exprEnd).trim(), alias: unquote(last.text) };
    }
    return { ...item, expr: item.text, alias: null };
  });
}

// `<alias>.<column>` or `<column>` as the whole expression, else null.
export function columnRef(expr: string): { alias: string | null; column: string } | null {
  const t = significant(tokenize(expr));
  if (t.length === 1 && t[0]!.type === "ident") return { alias: null, column: unquote(t[0]!.text) };
  if (t.length === 3 && t[0]!.type === "ident" && t[1]!.text === "." && t[2]!.type === "ident") {
    return { alias: unquote(t[0]!.text), column: unquote(t[2]!.text) };
  }
  return null;
}

// The CTEs a leading WITH clause declares, by name. fullScans and similar
// name-vs-table checks must not mistake a CTE reference for a real schema
// table that happens to share its name.
export function cteNames(sql: string): Set<string> {
  const t = significant(tokenize(sql));
  const names = new Set<string>();
  if (!isKeyword(t[0], "with")) return names;
  let i = 1;
  if (isKeyword(t[i], "recursive")) i++;
  while (t[i] && t[i]!.type === "ident") {
    names.add(unquote(t[i]!.text));
    i++;
    // An optional (col, col, ...) column list after the CTE name.
    if (t[i]?.text === "(") {
      const depth = t[i]!.depth;
      while (t[i] && !(t[i]!.text === ")" && t[i]!.depth === depth)) i++;
      i++;
    }
    if (isKeyword(t[i], "as")) i++;
    if (isKeyword(t[i], "not") && isKeyword(t[i + 1], "materialized")) i += 2;
    else if (isKeyword(t[i], "materialized")) i++;
    // The CTE's own (select ...) body.
    if (t[i]?.text === "(") {
      const depth = t[i]!.depth;
      while (t[i] && !(t[i]!.text === ")" && t[i]!.depth === depth)) i++;
      i++;
    }
    if (t[i]?.text === ",") { i++; continue; }
    break;
  }
  return names;
}

// Walks every `FROM t [AS] a`, `JOIN t [AS] a`, and comma-separated FROM-list
// entry, at any depth, calling `record` with the alias and its table (null
// for a subquery or a table-valued function). Shared by aliasMap and
// aliasCandidates so the two return shapes -- last-wins vs. every candidate
// -- don't duplicate this walk.
function walkAliases(sql: string, outerOnly: boolean, record: (alias: string, table: string | null) => void): void {
  const t = significant(tokenize(sql));
  const stop = new Set(["on", "where", "group", "order", "left", "right", "inner", "outer", "cross", "natural", "join", "using", "limit", "full", "union", "except", "intersect", "having", "window", "as", "set", "returning", "indexed", "not", "values"]);
  const endsFrom = new Set(["where", "group", "order", "limit", "having", "union", "except", "intersect", "returning", "set"]);
  // Depths at which a FROM list is open, so a comma there starts an entry.
  const openFrom = new Set<number>();
  // allowCall is false for an UPDATE or INSERT/REPLACE target: the token
  // after that table's name can be an INSERT column list, never a
  // table-valued function's arguments the way a FROM-list entry's can.
  const entry = (j: number, allowCall = true): void => {
    const first = t[j];
    if (!first) return;
    let table: string | null = null;
    if (first.text === "(") {
      let k = j + 1;
      while (t[k] && !(t[k]!.text === ")" && t[k]!.depth === first.depth)) k++;
      j = k + 1;
    } else if (first.type === "ident") {
      table = unquote(first.text);
      j++;
      if (allowCall && t[j]?.text === "(") {
        const d = t[j]!.depth;
        let k = j + 1;
        while (t[k] && !(t[k]!.text === ")" && t[k]!.depth === d)) k++;
        j = k + 1;
        table = null;
      }
    } else return;
    let alias = table;
    if (isKeyword(t[j], "as") && t[j + 1]) {
      alias = unquote(t[j + 1]!.text);
    } else if (t[j] && t[j]!.type === "ident" && !stop.has(t[j]!.text.toLowerCase())) {
      alias = unquote(t[j]!.text);
    }
    if (alias !== null) record(alias, table);
  };
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (outerOnly && tok.depth !== 0) continue;
    if (isKeyword(tok, "from")) {
      openFrom.add(tok.depth);
      entry(i + 1);
    } else if (isKeyword(tok, "update") || (isKeyword(tok, "into") && (isKeyword(t[i - 1], "insert") || isKeyword(t[i - 1], "replace") || isKeyword(t[i - 3], "insert")))) {
      // The target of UPDATE [OR ...] t [AS a], INSERT [OR ...] INTO t, and
      // REPLACE INTO t is a table that bare column names in the statement
      // refer to.
      let j = i + 1;
      if (isKeyword(t[j], "or")) j += 2;
      entry(j, false);
    } else if (isKeyword(tok, "join")) {
      entry(i + 1);
    } else if (tok.text === "," && openFrom.has(tok.depth)) {
      entry(i + 1);
    } else if (tok.type === "ident" && endsFrom.has(tok.text.toLowerCase())) {
      openFrom.delete(tok.depth);
    } else if (tok.text === ")") {
      openFrom.delete(tok.depth + 1);
    }
  }
}

// Alias to table name for every `FROM t [AS] a`, `JOIN t [AS] a`, and the
// comma-separated entries of a FROM list, at any depth. A subquery or a
// table-valued function maps its alias to null. A Map holds one value per
// key, so a later declaration of the same alias overwrites an earlier one;
// a caller that needs the declaration in a particular scope passes
// outerOnly or runs this on that scope's own extracted text (ADR 0051). A
// caller that cannot scope the text first wants aliasCandidates below.
export function aliasMap(sql: string, outerOnly = false): Map<string, string | null> {
  const map = new Map<string, string | null>();
  walkAliases(sql, outerOnly, (alias, table) => map.set(alias, table));
  return map;
}

// Alias to every table it was declared for, not just the last one: the
// same alias text can be declared for two different tables at two
// different points in one statement (an outer join's own alias and an
// unrelated subquery's own alias can collide by accident), and aliasMap
// can report only one of them. A table declared once for a real table and
// once for a derived table still reports the table.
export function aliasCandidates(sql: string, outerOnly = false): Map<string, Set<string | null>> {
  const map = new Map<string, Set<string | null>>();
  walkAliases(sql, outerOnly, (alias, table) => {
    let set = map.get(alias);
    if (!set) { set = new Set(); map.set(alias, set); }
    set.add(table);
  });
  return map;
}

// The text after a statement's own top-level RETURNING keyword -- found the
// way accesses() finds a write's own table, not by matching earlier in the
// text, so a RETURNING inside a CTE's own definition (not valid SQLite, but
// not this function's job to reject) cannot be mistaken for the statement's.
export function returningClause(sql: string): string | null {
  const tokens = tokenize(sql);
  const at = tokens.findIndex((t) => t.depth === 0 && isKeyword(t, "returning"));
  return at === -1 ? null : sql.slice(tokens[at]!.end);
}

// Where a named parameter sits, for type inference:
//   compare: `<column> <op> :p` or `:p <op> <column>`, or the row-value form
//            `(<column>, ...) <op> (:p, ...)` (either side may hold the
//            columns), each :p paired by position with the column at the
//            same position
//   set:     `set <column> = :p`, or the row-value form
//            `set (<column>, ...) = (:p, ...)`, each :p paired by position
//            with the column at the same position
//   insert:  `insert into <table> (<columns>) values (..., :p, ...)`
//   other:   anything else
//   in_json: `<column> in (select value from json_each(:p))`, an array
//   rows_json: `insert into t (c1, c2) select value ->> 'k1', value ->> 'k2' from json_each(:p)`, an array of objects
//   json_each: `json_each(:p)` anywhere else, an array. Each `value ->> 'key'`
//            in the same scope names a key, typed by the column it is compared
//            with or set into. A bare `value` in an INSERT ... SELECT names the
//            column its position gets.
//   one_of:  `case :p when 'a' ... when 'b'`, a union of the literals
//   number:  `limit :p`, `offset :p`
export type ParamSite =
  | { kind: "compare"; alias: string | null; column: string }
  | { kind: "set"; column: string }
  | { kind: "insert"; table: string; column: string }
  | { kind: "in_json"; alias: string | null; column: string }
  | { kind: "rows_json"; table: string; keys: { key: string; column: string }[] }
  | { kind: "json_each"; keys: { key: string; ref: { alias: string | null; column: string } | null }[]; scalar: { table: string; column: string } | null }
  | { kind: "one_of"; literals: string[] }
  | { kind: "number" }
  // `:p is null`: the optional-filter idiom, so the parameter allows null.
  | { kind: "nullable" }
  | { kind: "other" };

const compareOps = new Set(["=", "==", "<>", "!=", "<", ">", "<=", ">=", "like", "glob", "is", "match"]);

// A keyword that can open a boolean expression: the token before a "("
// candidate must be one of these (or "(", ",", or an operator -- anything
// that is not a bare identifier) for that "(" to be considered the start of
// a row-value tuple. Without this, `length(customer_id) = (:n)` would read
// as a one-column tuple compared against `(:n)`, narrowing a parameter a
// function call's argument list owns, not a comparison.
const tupleOpeners = new Set(["where", "and", "or", "not", "on", "having", "when"]);

export function paramSites(sql: string, locate = false): Map<string, (ParamSite & { offset?: number })[]> {
  const t = significant(tokenize(sql));
  const keys = new Map(namedSlots(sql).map(slot => [slot.sqlName, slot.key]));
  const key = (token: Token) => keys.get(token.text)!;
  const sites = new Map<string, (ParamSite & { offset?: number })[]>();
  let offset = 0;
  const add = (name: string, site: ParamSite, at = offset) => sites.set(name, [...(sites.get(name) ?? []), locate ? { ...site, offset: at } : site]);
  const refAt = (i: number, dir: -1 | 1): { alias: string | null; column: string; span: number } | null => {
    const a = t[i];
    if (!a || a.type !== "ident") return null;
    if (dir === -1 && t[i - 1]?.text === "." && t[i - 2]?.type === "ident") return { alias: unquote(t[i - 2]!.text), column: unquote(a.text), span: 3 };
    if (dir === 1 && t[i + 1]?.text === "." && t[i + 2]?.type === "ident") return { alias: unquote(a.text), column: unquote(t[i + 2]!.text), span: 3 };
    return { alias: null, column: unquote(a.text), span: 1 };
  };
  // set (c1, c2) = (:p1, :p2): a row-value assignment. Its right-hand
  // paren's own predecessor is always ")", never a bare column, so it can
  // never satisfy the `set c = :p` match below (which needs a bare column
  // immediately before "="); this shape needs its own scan, run once per
  // `set` keyword before the token loop below visits each parameter on its
  // own. A position is skipped, leaving its parameter for the generic
  // fallback, when its value slot is not a single bare parameter token (an
  // expression or a literal) or its right-hand side is a subquery (no
  // value-list commas to pair against).
  const setStops = new Set(["where", "from", "returning", "on"]);
  for (let i = 0; i < t.length; i++) {
    if (!isKeyword(t[i], "set")) continue;
    const setDepth = t[i]!.depth;
    let idx = i + 1;
    while (idx < t.length) {
      const cur = t[idx]!;
      if (cur.depth < setDepth) break;
      if (cur.depth === setDepth) {
        if (cur.text === ";") break;
        if (cur.type === "ident" && setStops.has(cur.text.toLowerCase())) break;
        if (cur.text === "(") {
          const assignment = rowValueAssignment(t, idx, setDepth);
          if (assignment) {
            for (const pair of assignment.pairs) {
              if (pair.value.end - pair.value.start !== 1) continue;
              const valueTok = t[pair.value.start]!;
              if (valueTok.type !== "param" || valueTok.text.startsWith("?")) continue;
              add(key(valueTok), { kind: "set", column: unquote(pair.column.text) }, valueTok.start);
              (t[pair.value.start] as { handled?: boolean }).handled = true;
            }
            idx = assignment.rhsClose + 1;
            continue;
          }
        }
      }
      idx++;
    }
  }
  // (c1, c2) <op> (:p1, :p2), anywhere a boolean expression can appear
  // (WHERE, ON, HAVING, a CASE WHEN), with the compared columns on either
  // side: a row-value comparison. Unlike the SET form above, its two sides
  // are not anchored to "columns on the left" -- SQLite accepts a column
  // list or a value list in either position -- so each position is judged
  // on its own, not by which side it came from. A site built here always
  // takes the `compare` kind, carrying the resolved alias, so it goes
  // through the same join-nullability-aware path (ofRef, in typegen.ts) a
  // plain `<column> <op> :p` already does, instead of `set`'s plainer
  // column lookup.
  for (let i = 0; i < t.length; i++) {
    if (t[i]!.text !== "(") continue;
    const comparison = rowValueComparison(t, i);
    if (!comparison) continue;
    for (const pair of comparison.pairs) {
      const leftRef = boundRef(t, pair.left);
      const rightRef = boundRef(t, pair.right);
      const leftParam = boundParam(t, pair.left);
      const rightParam = boundParam(t, pair.right);
      const ref = leftRef && rightParam ? leftRef : rightRef && leftParam ? rightRef : null;
      const paramTok = leftRef && rightParam ? rightParam : rightRef && leftParam ? leftParam : null;
      if (!ref || !paramTok) continue;
      add(key(paramTok), { kind: "compare", alias: ref.alias, column: ref.column }, paramTok.start);
      (paramTok as { handled?: boolean }).handled = true;
    }
    i = comparison.rhsClose;
  }
  // insert into T (c1, c2) values (v1, v2): map value position to column.
  let insertTable: string | null = null;
  let insertColumns: string[] = [];
  let valuesDepth = -1;
  let valueIndex = 0;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    offset = tok.start;
    const target = insertTarget(t, i);
    if (target !== null) {
      insertTable = unquote(t[target]!.text);
      let j = target + 1;
      if (t[j]?.text === "(") {
        const d = t[j]!.depth;
        const cols: string[] = [];
        let k = j + 1;
        while (t[k] && !(t[k]!.text === ")" && t[k]!.depth === d)) {
          if (t[k]!.type === "ident") cols.push(unquote(t[k]!.text));
          k++;
        }
        insertColumns = cols;
      }
      continue;
    }
    if (isKeyword(tok, "values") && insertTable && t[i + 1]?.text === "(") {
      valuesDepth = t[i + 1]!.depth + 1;
      valueIndex = 0;
      continue;
    }
    // insert into T (c1, c2) select e1, e2 ...: a select item that is one
    // parameter maps to the column at the same position.
    if (isKeyword(tok, "select") && insertTable && insertColumns.length > 0 && t[i - 1]?.text === ")" && t[i - 1]!.depth === tok.depth) {
      let index = 0;
      let itemStart = i + 1;
      // `value ->> 'key'` items, for a json_each source below.
      const keys: { key: string; column: string }[] = [];
      let scalar: string | null = null;
      let k = i + 1;
      for (; k <= t.length; k++) {
        const cur = t[k];
        const ends = !cur || (cur.depth === tok.depth && (cur.text === "," || isKeyword(cur, "from") || cur.text === ";"));
        if (!ends) continue;
        const column = insertColumns[index];
        if (k - itemStart === 1 && t[itemStart]!.type === "param" && !t[itemStart]!.text.startsWith("?") && column) {
          add(key(t[itemStart]!), { kind: "insert", table: insertTable, column }, t[itemStart]!.start);
          // Mark the token so the generic pass below skips it.
          (t[itemStart] as { handled?: boolean }).handled = true;
        }
        if (k - itemStart === 3 && isKeyword(t[itemStart], "value") && t[itemStart + 1]!.text === "->>" && t[itemStart + 2]!.type === "string" && column) {
          keys.push({ key: t[itemStart + 2]!.text.slice(1, -1).replace(/''/g, "'"), column });
        }
        if (k - itemStart === 1 && isKeyword(t[itemStart], "value") && column) scalar = column;
        index++;
        itemStart = k + 1;
        if (!cur || cur.text !== ",") break;
      }
      // ... from json_each(:rows)
      if (isKeyword(t[k], "from") && isKeyword(t[k + 1], "json_each") && t[k + 2]?.text === "(" && t[k + 3]?.type === "param" && t[k + 4]?.text === ")") {
        if (keys.length > 0) {
          add(key(t[k + 3]!), { kind: "rows_json", table: insertTable, keys }, t[k + 3]!.start);
          (t[k + 3] as { handled?: boolean }).handled = true;
        } else if (scalar !== null) {
          add(key(t[k + 3]!), { kind: "json_each", keys: [], scalar: { table: insertTable, column: scalar } }, t[k + 3]!.start);
          (t[k + 3] as { handled?: boolean }).handled = true;
        }
      }
      continue;
    }
    if (valuesDepth !== -1 && tok.text === "," && tok.depth === valuesDepth) valueIndex++;
    if (valuesDepth !== -1 && tok.text === ")" && tok.depth === valuesDepth - 1) {
      if (t[i + 1]?.text === "," && t[i + 2]?.text === "(") valueIndex = 0;
      else valuesDepth = -1;
    }
    if (tok.type !== "param" || tok.text.startsWith("?") || (tok as { handled?: boolean }).handled) continue;
    const name = key(tok);
    const prev = t[i - 1];
    const next = t[i + 1];
    if (valuesDepth !== -1 && tok.depth === valuesDepth && insertTable && insertColumns[valueIndex]) {
      add(name, { kind: "insert", table: insertTable, column: insertColumns[valueIndex]! });
      continue;
    }
    // <ref> in (select value from json_each(:p))
    if (
      prev?.text === "(" && isKeyword(t[i - 2], "json_each") && isKeyword(t[i - 3], "from") && isKeyword(t[i - 4], "value") &&
      isKeyword(t[i - 5], "select") && t[i - 6]?.text === "(" && isKeyword(t[i - 7], "in")
    ) {
      const ref = refAt(i - 8, -1);
      if (ref) {
        add(name, { kind: "in_json", alias: ref.alias, column: ref.column }, t[i - 8]!.start);
        continue;
      }
    }
    // json_each(:p) or json_tree(:p) anywhere else.
    if (prev?.text === "(" && (isKeyword(t[i - 2], "json_each") || isKeyword(t[i - 2], "json_tree")) && next?.text === ")") {
      add(name, { kind: "json_each", keys: jsonKeys(t, i), scalar: null });
      continue;
    }
    // case :p when 'a' then ... when 'b' then ... end
    if (isKeyword(prev, "case")) {
      const literals: string[] = [];
      for (let k = i + 1; k < t.length; k++) {
        const cur = t[k]!;
        if (cur.depth < tok.depth || (cur.depth === tok.depth && isKeyword(cur, "end"))) break;
        if (cur.depth === tok.depth && isKeyword(cur, "when") && t[k + 1]?.type === "string") literals.push(t[k + 1]!.text.slice(1, -1).replace(/''/g, "'"));
      }
      if (literals.length > 0) {
        add(name, { kind: "one_of", literals });
        continue;
      }
    }
    if (isKeyword(prev, "limit") || isKeyword(prev, "offset")) {
      add(name, { kind: "number" });
      continue;
    }
    // :p in ('a', 'b'): a union of the literals, like a CASE list.
    if (isKeyword(next, "in") && t[i + 2]?.text === "(") {
      const literals: string[] = [];
      let k = i + 3;
      for (; k < t.length && !(t[k]!.depth === tok.depth && t[k]!.text === ")"); k++) {
        const cur = t[k]!;
        if (cur.type === "string") literals.push(cur.text.slice(1, -1).replace(/''/g, "'"));
        else if (cur.text !== ",") break;
      }
      if (literals.length > 0 && t[k]?.text === ")") {
        add(name, { kind: "one_of", literals });
        continue;
      }
    }
    // :p = 'a' or 'a' = :p: the literal's type; a number literal gives number.
    const literalSite = (other: Token | undefined): ParamSite | null =>
      other?.type === "string" ? { kind: "one_of", literals: [other.text.slice(1, -1).replace(/''/g, "'")] } : other?.type === "number" ? { kind: "number" } : null;
    if (prev && compareOps.has(prev.text.toLowerCase())) {
      const site = literalSite(t[i - 2]);
      if (site) {
        add(name, site);
        continue;
      }
    }
    if (next && compareOps.has(next.text.toLowerCase())) {
      const site = literalSite(t[i + 2]);
      if (site) {
        add(name, site);
        continue;
      }
    }
    if (isKeyword(next, "is") && (isKeyword(t[i + 2], "null") || (isKeyword(t[i + 2], "not") && isKeyword(t[i + 3], "null")))) {
      add(name, { kind: "nullable" });
      continue;
    }
    if (prev && compareOps.has(prev.text.toLowerCase())) {
      const ref = refAt(i - 2, -1);
      const beforeRef = ref ? t[i - 2 - ref.span] : undefined;
      if (ref && isKeyword(beforeRef, "set") && prev.text === "=") {
        add(name, { kind: "set", column: ref.column });
        continue;
      }
      if (ref) {
        add(name, { kind: "compare", alias: ref.alias, column: ref.column });
        continue;
      }
    }
    if (next && compareOps.has(next.text.toLowerCase())) {
      const ref = refAt(i + 2, 1);
      if (ref) {
        add(name, { kind: "compare", alias: ref.alias, column: ref.column });
        continue;
      }
    }
    add(name, { kind: "other" });
  }
  return sites;
}

// The shape `(<cols>) = (<values>)` starting at the "(" of <cols>, at the
// depth of the enclosing SET clause, else null when what follows the
// column list is not "=" followed by another "(". A "with", "select", or
// "values" keyword right after the opening paren marks a subquery: its own
// top-level commas belong to a select list or a row constructor, not a
// value list lined up against <cols>, so pairing against them would be a
// coincidence of token shape, not a fact about the assignment.
function rowValueAssignment(
  t: readonly Token[],
  lhsOpen: number,
  setDepth: number,
): { rhsClose: number; pairs: { column: Token; value: { start: number; end: number } }[] } | null {
  let lhsClose = lhsOpen + 1;
  while (lhsClose < t.length && !(t[lhsClose]!.depth === setDepth && t[lhsClose]!.text === ")")) lhsClose++;
  if (
    lhsClose >= t.length ||
    t[lhsClose + 1]?.depth !== setDepth || t[lhsClose + 1]?.text !== "=" ||
    t[lhsClose + 2]?.depth !== setDepth || t[lhsClose + 2]?.text !== "("
  ) return null;
  const rhsOpen = lhsClose + 2;
  if (isKeyword(t[rhsOpen + 1], "with") || isKeyword(t[rhsOpen + 1], "select") || isKeyword(t[rhsOpen + 1], "values")) return null;
  let rhsClose = rhsOpen + 1;
  while (rhsClose < t.length && !(t[rhsClose]!.depth === setDepth && t[rhsClose]!.text === ")")) rhsClose++;
  if (rhsClose >= t.length) return null;
  const cols = tokenRanges(t, lhsOpen + 1, lhsClose);
  const values = tokenRanges(t, rhsOpen + 1, rhsClose);
  const pairs: { column: Token; value: { start: number; end: number } }[] = [];
  for (let pos = 0; pos < values.length; pos++) {
    const col = cols[pos];
    if (!col || col.end - col.start !== 1 || t[col.start]!.type !== "ident") continue;
    pairs.push({ column: t[col.start]!, value: values[pos]! });
  }
  return { rhsClose, pairs };
}

// The shape `(<left>, ...) <op> (<right>, ...)` starting at the "(" of
// <left>, for any of the 12 `compareOps` (generalizing `rowValueAssignment`,
// which only ever matches "="), else null. Three things must hold, checked
// in order: the "(" is not a function call's own argument list (the token
// before it is a boolean-expression-opening keyword, another "(", a comma,
// or an operator -- never a bare identifier); what follows the matching ")"
// is a comparison operator and then another "("; and neither side opens
// with "with", "select", or "values" (a subquery's own top-level commas
// belong to its select list or a row constructor, not a value list lined up
// position-for-position against the other side, on whichever side it
// appears -- a scalar subquery is legal on either side of a row-value
// comparison). The two ranges at each position are returned raw: which one
// is a column reference and which one is a parameter is a per-position
// question the caller answers, since either side may hold the columns.
function rowValueComparison(
  t: readonly Token[],
  lhsOpen: number,
): { rhsClose: number; pairs: { left: { start: number; end: number }; right: { start: number; end: number } }[] } | null {
  const prev = t[lhsOpen - 1];
  if (prev && prev.type === "ident" && !tupleOpeners.has(prev.text.toLowerCase())) return null;
  if (isKeyword(t[lhsOpen + 1], "with") || isKeyword(t[lhsOpen + 1], "select") || isKeyword(t[lhsOpen + 1], "values")) return null;
  const depth = t[lhsOpen]!.depth;
  let lhsClose = lhsOpen + 1;
  while (lhsClose < t.length && !(t[lhsClose]!.depth === depth && t[lhsClose]!.text === ")")) lhsClose++;
  if (lhsClose >= t.length) return null;
  const op = t[lhsClose + 1];
  if (!op || op.depth !== depth || !compareOps.has(op.text.toLowerCase())) return null;
  const rhsOpen = lhsClose + 2;
  if (t[rhsOpen]?.depth !== depth || t[rhsOpen]?.text !== "(") return null;
  if (isKeyword(t[rhsOpen + 1], "with") || isKeyword(t[rhsOpen + 1], "select") || isKeyword(t[rhsOpen + 1], "values")) return null;
  let rhsClose = rhsOpen + 1;
  while (rhsClose < t.length && !(t[rhsClose]!.depth === depth && t[rhsClose]!.text === ")")) rhsClose++;
  if (rhsClose >= t.length) return null;
  const lefts = tokenRanges(t, lhsOpen + 1, lhsClose);
  const rights = tokenRanges(t, rhsOpen + 1, rhsClose);
  if (lefts.length === 0 || lefts.length !== rights.length) return null;
  return { rhsClose, pairs: lefts.map((left, pos) => ({ left, right: rights[pos]! })) };
}

// A range that is a single bare column, or a single alias-qualified
// `alias.column` reference -- the same two shapes refAt resolves for a
// plain `<column> <op> :p` comparison, so a row-value position pairs with
// the identical `ofRef` lookup in typegen.ts.
function boundRef(t: readonly Token[], range: { start: number; end: number }): { alias: string | null; column: string } | null {
  const width = range.end - range.start;
  if (width === 1 && t[range.start]!.type === "ident") return { alias: null, column: unquote(t[range.start]!.text) };
  if (width === 3 && t[range.start]!.type === "ident" && t[range.start + 1]!.text === "." && t[range.start + 2]!.type === "ident") {
    return { alias: unquote(t[range.start]!.text), column: unquote(t[range.start + 2]!.text) };
  }
  return null;
}

// A range that is exactly `value ->> 'key'` -- the shape jsonKeys' own
// per-occurrence branches key off (an adjacent comparison operator or
// "select"), but boundRef cannot recognize, since its middle token is
// "->>", never ".". A row-value position spelling a JSON key needs this
// matcher, in the same style, to pair with the boundRef found at the
// tuple's matching position.
function boundJsonKey(t: readonly Token[], range: { start: number; end: number }): { key: string } | null {
  if (range.end - range.start !== 3) return null;
  if (!isKeyword(t[range.start], "value") || t[range.start + 1]!.text !== "->>" || t[range.start + 2]!.type !== "string") return null;
  return { key: t[range.start + 2]!.text.slice(1, -1).replace(/''/g, "'") };
}

// A range that is a single named parameter, not an anonymous "?" one (which
// carries no key to type).
function boundParam(t: readonly Token[], range: { start: number; end: number }): Token | null {
  const tok = t[range.start]!;
  return range.end - range.start === 1 && tok.type === "param" && !tok.text.startsWith("?") ? tok : null;
}

// Token-index ranges split at a token range's own top-level commas: the
// same split splitAtCommas does on text, but returning indices lets a
// caller test a range's token count and type directly, instead of
// re-tokenizing a text slice whose own offsets no longer point back at the
// original tokens.
function tokenRanges(t: readonly Token[], from: number, to: number): { start: number; end: number }[] {
  if (from >= to) return [];
  const base = t[from]!.depth;
  const out: { start: number; end: number }[] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    if (t[i]!.text === "," && t[i]!.depth === base) {
      out.push({ start, end: i });
      start = i + 1;
    }
  }
  out.push({ start, end: to });
  return out;
}

// The index of the table name in `insert [or <action>] into t` or
// `replace into t` when the tokens at i start one, else null.
function insertTarget(t: readonly Token[], i: number): number | null {
  if (isKeyword(t[i], "insert")) {
    const j = isKeyword(t[i + 1], "or") ? i + 3 : i + 1;
    return isKeyword(t[j], "into") && t[j + 1]?.type === "ident" ? j + 1 : null;
  }
  if (isKeyword(t[i], "replace") && !isKeyword(t[i - 1], "or") && isKeyword(t[i + 1], "into") && t[i + 2]?.type === "ident") return i + 2;
  return null;
}

// The `value ->> 'key'` uses in the scope of the json_each whose parameter
// sits at index p: the parenthesized region around the json_each call, or
// the whole statement. Each key carries the column it is compared with
// (`<ref> = value ->> 'k'`), set into (`set c = (select value ->> 'k' ...`),
// or listed for (`c in (select value ->> 'k' ...`), when one is written --
// or, for the two row-value shapes below, when it sits at a tuple position
// that pairs with a column at the same position, since none of those three
// per-occurrence checks ever sees a "(" or "," neighbor.
function jsonKeys(t: readonly Token[], p: number): { key: string; ref: { alias: string | null; column: string } | null }[] {
  const scope = t[p - 2]!.depth;
  let from = p;
  while (from > 0 && !(t[from]!.text === "(" && t[from]!.depth === scope - 1)) from--;
  let to = p;
  while (to < t.length && !(t[to]!.text === ")" && t[to]!.depth === scope - 1)) to++;
  const refAt = (i: number, dir: -1 | 1): { alias: string | null; column: string } | null => {
    const a = t[i];
    if (!a || a.type !== "ident") return null;
    if (dir === -1 && t[i - 1]?.text === "." && t[i - 2]?.type === "ident") return { alias: unquote(t[i - 2]!.text), column: unquote(a.text) };
    if (dir === 1 && t[i + 1]?.text === "." && t[i + 2]?.type === "ident") return { alias: unquote(a.text), column: unquote(t[i + 2]!.text) };
    return { alias: null, column: unquote(a.text) };
  };

  // Refs found by the two row-value shapes below, keyed by the "value"
  // token's own index, so the per-occurrence loop further down can look one
  // up instead of running its own neighbor checks against it.
  const positionRefs = new Map<number, { alias: string | null; column: string } | null>();

  // `(value ->> 'a', ...) <op> (col1, ...)`, in a WHERE, ON, HAVING, or CASE
  // WHEN -- either side may hold the JSON positions, matching how
  // rowValueComparison itself treats a row-value comparison generally. Its
  // own tupleOpeners check already keeps this from matching a function
  // call's argument list or a SET clause's own column list (whose preceding
  // keyword, "set", is not a tupleOpener), and its own "select" guard on
  // each side already keeps it from matching the SET-select shape below.
  for (let i = from; i < to; i++) {
    if (t[i]!.text !== "(") continue;
    const comparison = rowValueComparison(t, i);
    if (!comparison) continue;
    for (const pair of comparison.pairs) {
      const leftIsKey = boundJsonKey(t, pair.left);
      const rightIsKey = boundJsonKey(t, pair.right);
      const leftRef = boundRef(t, pair.left);
      const rightRef = boundRef(t, pair.right);
      if (leftIsKey && rightRef) positionRefs.set(pair.left.start, rightRef);
      else if (rightIsKey && leftRef) positionRefs.set(pair.right.start, leftRef);
    }
    i = comparison.rhsClose;
  }

  // `(c1, c2, ...) = (select value ->> 'a', value ->> 'b', ... from
  // json_each(...) ...)`: a row-value assignment (SET) or comparison
  // (WHERE/HAVING) whose right-hand side is a SELECT, which
  // rowValueAssignment (above, SET only) and rowValueComparison (above,
  // refuses a "select" right-hand side) both decline to look inside, so
  // this scope's own boundary is read directly instead -- `from` is this
  // SELECT's own "(" exactly when it is preceded by "=" and a column list's
  // closing ")", never a bare column (that shape stays branch three's own
  // job, below, unchanged, and covers both SET and WHERE already). No
  // "set" keyword is required before the column list: the same positional
  // pairing between the select list and the column list holds whichever
  // clause the "=" sits in, so one scan serves both.
  if (
    isKeyword(t[from + 1], "select") &&
    t[from - 1]?.text === "=" && t[from - 1]?.depth === t[from]!.depth &&
    t[from - 2]?.text === ")" && t[from - 2]?.depth === t[from]!.depth
  ) {
    const setDepth = t[from]!.depth;
    const lhsClose = from - 2;
    let lhsOpen = lhsClose - 1;
    while (lhsOpen > 0 && !(t[lhsOpen]!.depth === setDepth && t[lhsOpen]!.text === "(")) lhsOpen--;
    if (t[lhsOpen]?.text === "(") {
      const cols = tokenRanges(t, lhsOpen + 1, lhsClose);
      const selectDepth = t[from + 1]!.depth;
      let itemsEnd = to;
      for (let m = from + 2; m < to; m++) {
        if (t[m]!.depth === selectDepth && isKeyword(t[m], "from")) { itemsEnd = m; break; }
      }
      const items = tokenRanges(t, from + 2, itemsEnd);
      for (let pos = 0; pos < items.length; pos++) {
        const item = items[pos]!;
        const col = cols[pos];
        if (!col || !boundJsonKey(t, item)) continue;
        positionRefs.set(item.start, boundRef(t, col));
      }
    }
  }

  const keys = new Map<string, { alias: string | null; column: string } | null>();
  for (let k = from; k < to; k++) {
    if (!isKeyword(t[k], "value") || t[k + 1]?.text !== "->>" || t[k + 2]?.type !== "string") continue;
    const key = t[k + 2]!.text.slice(1, -1).replace(/''/g, "'");
    let ref: { alias: string | null; column: string } | null = null;
    const before = t[k - 1];
    const after = t[k + 3];
    if (positionRefs.has(k)) {
      ref = positionRefs.get(k) ?? null;
    } else if (before && compareOps.has(before.text.toLowerCase())) {
      const r = refAt(k - 2, -1);
      ref = r ?? (t[k - 2]?.text === "." ? refAt(k - 2, -1) : null);
    } else if (after && compareOps.has(after.text.toLowerCase())) {
      ref = refAt(k + 4, 1);
    } else if (isKeyword(before, "select") && t[k - 2]?.text === "(" && (t[k - 3]?.text === "=" || isKeyword(t[k - 3], "in"))) {
      ref = refAt(k - 4, -1);
    }
    if (!keys.has(key) || (keys.get(key) === null && ref !== null)) keys.set(key, ref);
  }
  return [...keys].map(([key, ref]) => ({ key, ref }));
}

// --- CREATE TABLE text ---------------------------------------------------------

// The text between the outer parentheses of a CREATE TABLE, and the tail
// after them (WITHOUT ROWID, STRICT).
export function tableBody(sql: string): { body: string; tail: string } | null {
  const all = tokenize(sql);
  const open = all.find((t) => t.text === "(" && t.depth === 0);
  if (!open) return null;
  const close = all.find((t) => t.text === ")" && t.depth === 0 && t.start > open.start);
  if (!close) return null;
  return { body: sql.slice(open.end, close.start), tail: sql.slice(close.end) };
}

const constraintKeywords = new Set(["constraint", "primary", "unique", "check", "foreign"]);

// Column definitions by name (normalized, with the name unquoted) and the
// table constraints (normalized).
export function definitions(sql: string): { columns: Map<string, string>; constraints: string[] } | null {
  const tb = tableBody(sql);
  if (!tb) return null;
  const all = tokenize(tb.body);
  const columns = new Map<string, string>();
  const constraints: string[] = [];
  for (const item of splitAtCommas(tb.body, all, 0, all.length)) {
    const first = significant(tokenize(item.text))[0];
    if (!first) continue;
    if (constraintKeywords.has(first.text.toLowerCase())) constraints.push(normalize(item.text));
    else columns.set(unquote(first.text), normalize(unquote(first.text) + item.text.slice(first.end)));
  }
  return { columns, constraints };
}

// --- migration files ----------------------------------------------------------

// Statements of a file, split at top-level semicolons. A trigger body keeps
// its semicolons: BEGIN starts it, and only its own closing END — not a
// CASE expression's END, and not a bare "end" identifier — ends it.
export function splitStatements(sql: string): string[] {
  const all = tokenize(sql);
  const out: string[] = [];
  let inTrigger = false;
  let start = 0;
  // Only a CREATE TRIGGER statement has a BEGIN ... END body. A table named
  // `begin` or a BEGIN TRANSACTION statement must not open one.
  let createTrigger = false;
  let first: Token | null = null;
  // The trigger body's own closing END is the only bare "end" token
  // immediately preceded (ignoring whitespace and comments) by ";" at depth
  // 0, or by the exact BEGIN token that opened this body. Comparing the
  // opening BEGIN by identity, not by spelling, matters: SQLite allows a
  // column alias without AS, so `select begin end from t` is valid SQL and
  // puts an unrelated "begin"/"end" pair inside a trigger body. A CASE
  // expression's own END, and any reference or column literally named end,
  // is preceded by its own operand instead, so this precondition tells the
  // two apart without tracking CASE nesting.
  let prev: Token | null = null;
  let triggerBegin: Token | null = null;
  for (let i = 0; i < all.length; i++) {
    const t = all[i]!;
    if (t.type === "ws" || t.type === "comment") continue;
    if (first === null) first = t;
    if (isKeyword(first, "create") && t.depth === 0 && isKeyword(t, "trigger")) createTrigger = true;
    if (createTrigger && !inTrigger && t.depth === 0 && isKeyword(t, "begin")) {
      inTrigger = true;
      triggerBegin = t;
    }
    if (
      t.depth === 0 && inTrigger && isKeyword(t, "end") &&
      prev !== null && (prev === triggerBegin || (prev.type === "punct" && prev.text === ";"))
    ) {
      inTrigger = false;
      triggerBegin = null;
    }
    if (t.type === "punct" && t.text === ";" && t.depth === 0 && !inTrigger) {
      const text = stripComments(sql.slice(start, t.start)).trim();
      if (text.length > 0) out.push(text);
      start = t.end;
      first = null;
      createTrigger = false;
    }
    prev = t;
  }
  const rest = stripComments(sql.slice(start)).trim();
  if (rest.length > 0) out.push(rest);
  return out;
}

function stripComments(text: string): string {
  return tokenize(text)
    .filter((t) => t.type !== "comment")
    .map((t) => t.text)
    .join("");
}

// Only the complete predicate proves this alias present. An OR, a different
// alias, or a more complex predicate must retain the join's nullable type.
export function nonNullFilterAlias(expr: string): string | null {
  const filter = findCall(expr, "filter");
  if (!filter || filter.args.length !== 1) return null;
  const tokens = significant(tokenize(filter.args[0]!.text));
  if (tokens.length !== 7 || tokens[0]!.text.toLowerCase() !== "where" || tokens[4]!.text.toLowerCase() !== "is" || tokens[5]!.text.toLowerCase() !== "not" || tokens[6]!.text.toLowerCase() !== "null") return null;
  const ref = columnRef(tokens.slice(1, 4).map((token) => token.text).join(""));
  return ref?.alias ?? null;
}

// Aliases with a WHERE-clause conjunct that unconditionally requires
// "<alias> MATCH <expr>" to hold for every row a statement can return.
// The WHERE clause is split on its depth-0 "and" tokens; a conjunct
// qualifies only when its first two tokens are exactly an identifier
// followed by MATCH. A depth-0 "or" anywhere in the clause disqualifies
// the whole clause: confirmed empirically that SQLite both prepares and
// executes "where <cond> or <fts> match <expr>", returning a real row
// where the match did not hold (rank genuinely null there) -- depth 0
// alone, without this check, would be an unsound rule. A "not" directly
// before the identifier is excluded by the same exact-shape requirement
// (its conjunct then starts with "not", not an identifier), though this
// is for simplicity, not soundness: "where not (f match ...)" already
// fails at execution, not merely at typing, so it cannot itself return a
// row with a wrong type. A conjunct wrapped in its own parentheses, or a
// qualified "<alias>.<column> match" form, is conservatively not
// recognized (a safe loss of precision, not unsound).
export function unconditionalMatchAliases(sql: string): Set<string> {
  const t = significant(tokenize(sql));
  const start = t.findIndex((tok) => tok.depth === 0 && isKeyword(tok, "where"));
  if (start === -1) return new Set();
  const stop = new Set(["group", "order", "limit", "having", "union", "except", "intersect", "returning", "window"]);
  let end = t.length;
  for (let i = start + 1; i < t.length; i++) {
    if (t[i]!.depth === 0 && stop.has(unquote(t[i]!.text).toLowerCase()) && t[i]!.type === "ident") { end = i; break; }
  }
  const clause = t.slice(start + 1, end);
  if (clause.some((tok) => tok.depth === 0 && isKeyword(tok, "or"))) return new Set();
  const out = new Set<string>();
  let conjunctStart = 0;
  for (let i = 0; i <= clause.length; i++) {
    if (i === clause.length || (clause[i]!.depth === 0 && isKeyword(clause[i], "and"))) {
      const conjunct = clause.slice(conjunctStart, i);
      if (conjunct.length >= 2 && conjunct[0]!.type === "ident" && isKeyword(conjunct[1], "match")) {
        out.add(unquote(conjunct[0]!.text));
      }
      conjunctStart = i + 1;
    }
  }
  return out;
}

// A migration file that rebuilds a table records, in one comment line
// render() writes, the shape tableStatements saw for that table at
// generation time: each column's normalized declaration text (the same
// text definitions()/normalize() already produce, and Column.def already
// holds), not only its name. Replay compares the table's actual shape,
// immediately before the file runs, against this record (ADR 0101). A
// table whose CREATE statement has no explicit column-definition list
// (definitions() finds none) records every column's declaration as the
// empty string, on both sides, so the comparison is vacuous for that
// table -- the same as having nothing recorded. A file with no such line,
// or one that fails to parse, has nothing recorded: callers treat that
// the same as an empty list, not as an error, so a file written before
// this feature existed, or under ADR 0099's column-name-only format,
// replays exactly as it did before. The record also holds the table-level
// constraints, indexes, and triggers the generator saw attached to the
// table, each as a normalized declaration, compared the same way (ADR 0102).
export type RebuildRecord = {
  table: string;
  columns: { name: string; def: string }[];
  constraints: string[];
  indexes: string[];
  triggers: string[];
};

export const REBUILD_HEADER = "-- Rebuilds from this shape: ";

export function parseRebuildRecords(sql: string): RebuildRecord[] {
  const line = sql.split("\n").find((l) => l.startsWith(REBUILD_HEADER));
  if (!line) return [];
  const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  try {
    const value: unknown = JSON.parse(line.slice(REBUILD_HEADER.length));
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is RebuildRecord =>
      v !== null && typeof v === "object" &&
      typeof (v as { table?: unknown }).table === "string" &&
      Array.isArray((v as { columns?: unknown }).columns) &&
      (v as { columns: unknown[] }).columns.every((c) =>
        c !== null && typeof c === "object" &&
        typeof (c as { name?: unknown }).name === "string" &&
        typeof (c as { def?: unknown }).def === "string",
      ) &&
      isStringArray((v as { constraints?: unknown }).constraints) &&
      isStringArray((v as { indexes?: unknown }).indexes) &&
      isStringArray((v as { triggers?: unknown }).triggers),
    );
  } catch {
    return [];
  }
}

// A declaration present at replay but absent from what a rebuild's
// generator recorded seeing: something added since generation, which the
// rebuild's own statements do not know to recreate. The reverse -- recorded
// but no longer present -- is not a gap here: it is the rebuild's own
// intentional drop, the same case ADR 0099 already allows for a column.
export function unknownDeclaration(recorded: readonly string[], actual: readonly string[]): string | undefined {
  const known = new Set(recorded);
  return actual.find((a) => !known.has(a));
}

// The table-level constraints, indexes, and triggers a migration file's own
// statements redeclare for one table, read from the file's SQL text rather
// than from any RebuildRecord: a constraint from the file's own `CREATE
// TABLE "_solarsql_new_<table>"` (the name renamedCreate(), in
// src/build/migration.ts, always gives a rebuild's fresh copy), through the
// same definitions() that already reads a live table's constraints; an
// index or a trigger from every CREATE INDEX/CREATE TRIGGER statement in the
// file whose own target table -- indexTarget()/triggerTarget() above, a
// tokenized fact, not a text search -- is this table. A word-boundary regex
// or a substring search on the table name cannot make that call soundly: in
// a file that rebuilds both "t" and "tt" in one pass, "on tt(" contains "on
// t" as a prefix, so a check anchored only on the left of the name would
// attribute "tt"'s own index to "t" too (confirmed against the real
// tokenizer before this function existed). The table name comparison is
// case-insensitive for the same reason durable.ts's own table lookups are
// (see the comment at its `schemaRow` lookup): a RebuildRecord's `table`
// field and this function's own table argument can differ only in case, not
// in spelling, from the live table and the file's own generated name.
export function redeclaredByFile(fileSql: string, table: string): { constraints: string[]; indexes: string[]; triggers: string[] } {
  const constraints: string[] = [];
  const indexes: string[] = [];
  const triggers: string[] = [];
  const freshName = `_solarsql_new_${table}`.toLowerCase();
  for (const statement of splitStatements(fileSql)) {
    const c = created(statement);
    if (c?.kind === "table" && c.name.toLowerCase() === freshName) {
      constraints.push(...(definitions(statement)?.constraints ?? []));
      continue;
    }
    const index = indexTarget(statement);
    if (index && index.table.toLowerCase() === table.toLowerCase()) {
      indexes.push(normalize(statement));
      continue;
    }
    const trigger = triggerTarget(statement);
    if (trigger && trigger.table.toLowerCase() === table.toLowerCase()) {
      triggers.push(normalize(statement));
      continue;
    }
  }
  return { constraints, indexes, triggers };
}

// A declaration recorded at generation time, missing from the live schema
// immediately before replay -- a sibling migration removed it since -- that
// this same file's own statements redeclare for the table (redeclaredByFile,
// above): reviving a sibling's drop with no refusal, the gap ADR 0102's
// Consequences named and left open. The reverse of unknownDeclaration above,
// and always called alongside it, never in its place: unknownDeclaration
// still owns the "sibling added something this rebuild does not know to
// recreate" direction, this function owns the mirror direction, "this
// rebuild's own target schema still declares something a sibling removed."
// An index or a trigger has a name, so it matches redeclared by name
// (created(x)?.name): a sibling's clean drop of "idx1" is still a revival
// even when this file also edited "idx1"'s own definition since it was
// recorded, which exact-text matching alone would miss (measured: branch A
// changes its own idx1 from "on t(c)" to "on t(c, a)", branch B drops idx1
// outright; the recorded and the redeclared text differ, but the name does
// not). A table-level constraint has no name, so it matches only by exact
// normalized text -- the same limit ADR 0102 already accepted for
// unknownDeclaration's own direction, for the same reason.
export function revivedDeclaration(recorded: readonly string[], actual: readonly string[], redeclared: readonly string[], byName: boolean): string | undefined {
  const live = new Set(actual);
  const missing = recorded.filter((r) => !live.has(r));
  if (!byName) {
    const redeclaredSet = new Set(redeclared);
    return missing.find((r) => redeclaredSet.has(r));
  }
  const redeclaredNames = new Set(redeclared.map((r) => created(r)?.name).filter((n): n is string => n !== undefined));
  return missing.find((r) => {
    const name = created(r)?.name;
    return name !== undefined && redeclaredNames.has(name);
  });
}
