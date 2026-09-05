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
      const m = /^[:@$][A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
      if (m) {
        push("param", i + m[0].length);
        continue;
      }
    }
    if (ch === "?") {
      const m = /^\?[0-9]*/.exec(sql.slice(i))!;
      push("param", i + m[0].length);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const m = /^(?:0x[0-9A-Fa-f]+|[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|[0-9]+\.?)/.exec(sql.slice(i))!;
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
export function namedParams(sql: string): { names: string[]; anonymous: Token[] } {
  const names: string[] = [];
  const anonymous: Token[] = [];
  for (const t of tokenize(sql)) {
    if (t.type !== "param") continue;
    if (t.text.startsWith("?")) {
      anonymous.push(t);
      continue;
    }
    const name = t.text.slice(1);
    if (!names.includes(name)) names.push(name);
  }
  return { names, anonymous };
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
  return tokenize(text)
    .filter((t) => t.type !== "comment")
    .map((t) => (t.type === "ws" ? " " : t.type === "ident" && !/^["`[]/.test(t.text) ? t.text.toLowerCase() : t.text))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/\s*([(,])\s*/g, "$1")
    .replace(/\s*\)/g, ")")
    .trim();
}

// The name a CREATE statement creates, and what kind of object it is.
export function created(sql: string): { kind: "table" | "index" | "trigger" | "view"; name: string } | null {
  const t = significant(tokenize(sql));
  if (!isKeyword(t[0], "create")) return null;
  let i = 1;
  if (isKeyword(t[i], "unique") || isKeyword(t[i], "temp") || isKeyword(t[i], "temporary")) i++;
  const kind = t[i]?.text.toLowerCase();
  if (kind !== "table" && kind !== "index" && kind !== "trigger" && kind !== "view") return null;
  i++;
  if (isKeyword(t[i], "if") && isKeyword(t[i + 1], "not") && isKeyword(t[i + 2], "exists")) i += 3;
  const name = t[i];
  if (!name || name.type !== "ident") return null;
  return { kind, name: unquote(name.text) };
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

// Alias to table name for every `FROM t [AS] a`, `JOIN t [AS] a`, and the
// comma-separated entries of a FROM list, at any depth. A subquery or a
// table-valued function maps its alias to null.
export function aliasMap(sql: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const t = significant(tokenize(sql));
  const stop = new Set(["on", "where", "group", "order", "left", "right", "inner", "outer", "cross", "natural", "join", "using", "limit", "full", "union", "except", "intersect", "having", "window", "as", "set", "returning"]);
  const endsFrom = new Set(["where", "group", "order", "limit", "having", "union", "except", "intersect", "returning", "set"]);
  // Depths at which a FROM list is open, so a comma there starts an entry.
  const openFrom = new Set<number>();
  const entry = (j: number): void => {
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
      if (t[j]?.text === "(") {
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
    if (alias !== null) map.set(alias, table);
  };
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (isKeyword(tok, "from")) {
      openFrom.add(tok.depth);
      entry(i + 1);
    } else if (isKeyword(tok, "update") || (isKeyword(tok, "into") && isKeyword(t[i - 1], "insert"))) {
      // The target of UPDATE [OR ...] t [AS a] and INSERT INTO t is a table
      // that bare column names in the statement refer to.
      let j = i + 1;
      if (isKeyword(t[j], "or")) j += 2;
      entry(j);
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
  return map;
}

// Where a named parameter sits, for type inference:
//   compare: `<column> <op> :p` or `:p <op> <column>`
//   set:     `set <column> = :p`
//   insert:  `insert into <table> (<columns>) values (..., :p, ...)`
//   other:   anything else
//   in_json: `<column> in (select value from json_each(:p))`, an array
//   rows_json: `insert into t (c1, c2) select value ->> 'k1', value ->> 'k2' from json_each(:p)`, an array of objects
//   one_of:  `case :p when 'a' ... when 'b'`, a union of the literals
//   number:  `limit :p`, `offset :p`
export type ParamSite =
  | { kind: "compare"; alias: string | null; column: string }
  | { kind: "set"; column: string }
  | { kind: "insert"; table: string; column: string }
  | { kind: "in_json"; alias: string | null; column: string }
  | { kind: "rows_json"; table: string; keys: { key: string; column: string }[] }
  | { kind: "one_of"; literals: string[] }
  | { kind: "number" }
  // `:p is null`: the optional-filter idiom, so the parameter allows null.
  | { kind: "nullable" }
  | { kind: "other" };

const compareOps = new Set(["=", "==", "<>", "!=", "<", ">", "<=", ">=", "like", "glob", "is"]);

export function paramSites(sql: string): Map<string, ParamSite[]> {
  const t = significant(tokenize(sql));
  const sites = new Map<string, ParamSite[]>();
  const add = (name: string, site: ParamSite) => sites.set(name, [...(sites.get(name) ?? []), site]);
  const refAt = (i: number, dir: -1 | 1): { alias: string | null; column: string; span: number } | null => {
    const a = t[i];
    if (!a || a.type !== "ident") return null;
    if (dir === -1 && t[i - 1]?.text === "." && t[i - 2]?.type === "ident") return { alias: unquote(t[i - 2]!.text), column: unquote(a.text), span: 3 };
    if (dir === 1 && t[i + 1]?.text === "." && t[i + 2]?.type === "ident") return { alias: unquote(a.text), column: unquote(t[i + 2]!.text), span: 3 };
    return { alias: null, column: unquote(a.text), span: 1 };
  };
  // insert into T (c1, c2) values (v1, v2): map value position to column.
  let insertTable: string | null = null;
  let insertColumns: string[] = [];
  let valuesDepth = -1;
  let valueIndex = 0;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (isKeyword(tok, "insert") && isKeyword(t[i + 1], "into") && t[i + 2]?.type === "ident") {
      insertTable = unquote(t[i + 2]!.text);
      let j = i + 3;
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
      let k = i + 1;
      for (; k <= t.length; k++) {
        const cur = t[k];
        const ends = !cur || (cur.depth === tok.depth && (cur.text === "," || isKeyword(cur, "from") || cur.text === ";"));
        if (!ends) continue;
        const column = insertColumns[index];
        if (k - itemStart === 1 && t[itemStart]!.type === "param" && t[itemStart]!.text.startsWith(":") && column) {
          add(t[itemStart]!.text.slice(1), { kind: "insert", table: insertTable, column });
          // Mark the token so the generic pass below skips it.
          (t[itemStart] as { handled?: boolean }).handled = true;
        }
        if (k - itemStart === 3 && isKeyword(t[itemStart], "value") && t[itemStart + 1]!.text === "->>" && t[itemStart + 2]!.type === "string" && column) {
          keys.push({ key: t[itemStart + 2]!.text.slice(1, -1).replace(/''/g, "'"), column });
        }
        index++;
        itemStart = k + 1;
        if (!cur || cur.text !== ",") break;
      }
      // ... from json_each(:rows)
      if (isKeyword(t[k], "from") && isKeyword(t[k + 1], "json_each") && t[k + 2]?.text === "(" && t[k + 3]?.type === "param" && t[k + 4]?.text === ")" && keys.length > 0) {
        add(t[k + 3]!.text.slice(1), { kind: "rows_json", table: insertTable, keys });
        (t[k + 3] as { handled?: boolean }).handled = true;
      }
      continue;
    }
    if (valuesDepth !== -1 && tok.text === "," && tok.depth === valuesDepth) valueIndex++;
    if (valuesDepth !== -1 && tok.text === ")" && tok.depth === valuesDepth - 1) valuesDepth = -1;
    if (tok.type !== "param" || !tok.text.startsWith(":") || (tok as { handled?: boolean }).handled) continue;
    const name = tok.text.slice(1);
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
        add(name, { kind: "in_json", alias: ref.alias, column: ref.column });
        continue;
      }
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
// its semicolons: BEGIN starts it unless the next word makes it a
// transaction statement, END closes it.
export function splitStatements(sql: string): string[] {
  const all = tokenize(sql);
  const out: string[] = [];
  let inTrigger = false;
  let start = 0;
  // Only a CREATE TRIGGER statement has a BEGIN ... END body. A table named
  // `begin` or a BEGIN TRANSACTION statement must not open one.
  let createTrigger = false;
  let first: Token | null = null;
  for (let i = 0; i < all.length; i++) {
    const t = all[i]!;
    if (t.type === "ws" || t.type === "comment") continue;
    if (first === null) first = t;
    if (isKeyword(first, "create") && t.depth === 0 && isKeyword(t, "trigger")) createTrigger = true;
    if (createTrigger && t.depth === 0 && isKeyword(t, "begin")) inTrigger = true;
    if (t.depth === 0 && inTrigger && isKeyword(t, "end")) inTrigger = false;
    if (t.type === "punct" && t.text === ";" && t.depth === 0 && !inTrigger) {
      const text = stripComments(sql.slice(start, t.start)).trim();
      if (text.length > 0) out.push(text);
      start = t.end;
      first = null;
      createTrigger = false;
    }
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
