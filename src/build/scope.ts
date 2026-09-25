// Responsibility: describe query scopes after SQLite validates the SQL.
// Boundary: this parser records bindings and join structure, not expression types
// or SQL validity. Unknown source shapes are reported instead of guessed.
import { isKeyword, significant, tokenize, unquote, type Token } from "./scan.ts";

export type Cte = { name: string; columns: string[]; sql: string };
export type Source = {
  alias: string;
  name: string | null;
  schema: string | null;
  query: string | null;
  functionSql: string | null;
  join: "inner" | "left" | "right" | "full";
  using: string[];
  natural: boolean;
  // This source's own ON expression text, or null: a comma join, a USING
  // join, a NATURAL join, and the first FROM source never have one. Used by
  // the join fan-out proof (typegen.ts, ADR 0136) to find which columns an
  // alias is equated against.
  on: string | null;
};
export type QueryScope = { ctes: Cte[]; branches: string[]; operators: string[] };
export const sqliteName = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

// One side of an ON clause's equality conjunct: a bare or alias-qualified
// column, with its own explicit COLLATE override when the conjunct wrote
// one, or null to defer to the column's declared collation.
function sideRef(tokens: Token[]): { alias: string | null; column: string; collate: string | null } | null {
  let t = tokens;
  let collate: string | null = null;
  if (t.length >= 2 && isKeyword(t[t.length - 2], "collate")) {
    collate = unquote(t[t.length - 1]!.text).toUpperCase();
    t = t.slice(0, -2);
  }
  if (t.length === 1 && t[0]!.type === "ident") return { alias: null, column: unquote(t[0]!.text), collate };
  if (t.length === 3 && t[0]!.type === "ident" && t[1]!.text === "." && t[2]!.type === "ident") return { alias: unquote(t[0]!.text), column: unquote(t[2]!.text), collate };
  return null;
}

// Whether `tokens` names `alias` anywhere, qualified (`alias.col`). A join
// fan-out proof (typegen.ts, ADR 0136) needs the equality's other side to
// not reference the alias being proven, or the equality is circular, not a
// join key.
function referencesAlias(tokens: Token[], alias: string): boolean {
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i]!.type === "ident" && tokens[i + 1]!.text === "." && sqliteName(unquote(tokens[i]!.text)) === sqliteName(alias)) return true;
  }
  return false;
}

// From one source's ON clause, the columns of `alias` that a depth-0 AND
// chain equates against an expression that does not itself reference
// `alias`, each with its own explicit COLLATE override or null: a join
// fan-out proof's per-source half (typegen.ts, ADR 0136). A bare
// (unqualified) column on either side is not counted, since this parser
// carries no schema to resolve which source it belongs to. Returns null
// when a depth-0 OR sits in the clause: an OR can satisfy the join without
// every conjunct holding for every matched row, the same reasoning
// unconditionalMatchAliases (scan.ts) already applies to WHERE.
export function onEqualities(on: string, alias: string): Map<string, string | null> | null {
  const tokens = significant(tokenize(on));
  if (tokens.length === 0) return new Map();
  if (tokens.some((t) => t.depth === 0 && isKeyword(t, "or"))) return null;
  const out = new Map<string, string | null>();
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i !== tokens.length && !(tokens[i]!.depth === 0 && isKeyword(tokens[i], "and"))) continue;
    const conjunct = tokens.slice(start, i);
    start = i + 1;
    const eq = conjunct.findIndex((t) => t.depth === 0 && t.text === "=");
    if (eq <= 0 || eq >= conjunct.length - 1) continue;
    const left = sideRef(conjunct.slice(0, eq));
    const right = sideRef(conjunct.slice(eq + 1));
    const bSide = left && left.alias !== null && sqliteName(left.alias) === sqliteName(alias) ? { ref: left, other: conjunct.slice(eq + 1) }
      : right && right.alias !== null && sqliteName(right.alias) === sqliteName(alias) ? { ref: right, other: conjunct.slice(0, eq) }
      : null;
    if (!bSide || referencesAlias(bSide.other, alias)) continue;
    // An explicit COLLATE binds to SQLite's comparison operator, not to one
    // operand: whichever side wrote one decides the comparison's collation,
    // overriding either operand's own declared collation.
    out.set(sqliteName(bSide.ref.column), left?.collate ?? right?.collate ?? null);
  }
  return out;
}

function close(tokens: Token[], index: number): number {
  const depth = tokens[index]!.depth;
  let i = index + 1;
  while (tokens[i] && !(tokens[i]!.text === ")" && tokens[i]!.depth === depth)) i++;
  if (!tokens[i]) throw new Error("unclosed query scope");
  return i;
}

export function queryScope(sql: string, bindingsOnly = false): QueryScope {
  const tokens = significant(tokenize(sql));
  const ctes: Cte[] = [];
  let i = 0;
  if (isKeyword(tokens[i], "with")) {
    i++;
    if (isKeyword(tokens[i], "recursive")) i++;
    for (;;) {
      const name = unquote(tokens[i++]!.text);
      const columns: string[] = [];
      if (tokens[i]?.text === "(") {
        const end = close(tokens, i);
        columns.push(...tokens.slice(i + 1, end).filter((t) => t.text !== ",").map((t) => unquote(t.text)));
        i = end + 1;
      }
      if (!isKeyword(tokens[i++], "as")) throw new Error("unrecognized CTE binding");
      if (isKeyword(tokens[i], "not")) i++;
      if (isKeyword(tokens[i], "materialized")) i++;
      if (tokens[i]?.text !== "(") throw new Error("unrecognized CTE query");
      const end = close(tokens, i);
      ctes.push({ name, columns, sql: sql.slice(tokens[i]!.end, tokens[end]!.start) });
      i = end + 1;
      if (tokens[i]?.text !== ",") break;
      i++;
    }
  }
  if (bindingsOnly) return { ctes, branches: [], operators: [] };
  if (!isKeyword(tokens[i], "select") && !isKeyword(tokens[i], "values")) throw new Error("query scope needs SELECT or VALUES");
  const branches: string[] = [];
  const operators: string[] = [];
  let start = tokens[i]!.start;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.depth !== 0) continue;
    if (["union", "intersect", "except"].some((word) => isKeyword(t, word))) {
      branches.push(sql.slice(start, t.start).trim());
      let operator = t.text.toLowerCase();
      if (isKeyword(tokens[i + 1], "all")) { operator += " all"; i++; }
      operators.push(operator);
      start = tokens[i + 1]!.start;
    }
  }
  let end = sql.length;
  if (operators.length > 0) {
    const tail = tokens.find((t) => t.depth === 0 && t.start >= start && (isKeyword(t, "order") || isKeyword(t, "limit")));
    if (tail) end = tail.start;
  }
  branches.push(sql.slice(start, end).replace(/;\s*$/, "").trim());
  return { ctes, branches, operators };
}

const attributes = new Set(["natural", "left", "right", "full", "inner", "outer", "cross"]);
const clauses = new Set(["where", "group", "having", "window", "order", "limit", "returning"]);
export function querySources(sql: string): Source[] {
  const tokens = significant(tokenize(sql));
  const from = tokens.findIndex((t) => t.depth === 0 && isKeyword(t, "from"));
  if (from < 0) return [];
  const sources: Source[] = [];
  let i = from + 1;
  let join: Source["join"] = "inner";
  let natural = false;
  for (;;) {
    const first = tokens[i];
    if (!first) throw new Error("missing FROM source");
    let name: string | null = null;
    let schema: string | null = null;
    let query: string | null = null;
    let functionSql: string | null = null;
    if (first.text === "(") {
      const end = close(tokens, i);
      query = sql.slice(first.end, tokens[end]!.start);
      if (!/^\s*(?:select|with|values)\b/i.test(query)) throw new Error("parenthesized join groups need an explicit SELECT scope");
      i = end + 1;
    } else {
      if (first.type !== "ident") throw new Error("unrecognized FROM source");
      name = unquote(first.text);
      i++;
      if (tokens[i]?.text === ".") {
        schema = name;
        name = unquote(tokens[i + 1]!.text);
        i += 2;
      }
      if (tokens[i]?.text === "(") {
        const end = close(tokens, i);
        functionSql = sql.slice(first.start, tokens[end]!.end);
        i = end + 1;
      }
    }
    let alias = name;
    if (isKeyword(tokens[i], "as")) { alias = unquote(tokens[i + 1]!.text); i += 2; }
    else if (tokens[i]?.type === "ident" && !attributes.has(tokens[i]!.text.toLowerCase()) && !clauses.has(tokens[i]!.text.toLowerCase()) && !["join", "on", "using", "indexed", "not"].some((w) => isKeyword(tokens[i], w))) {
      alias = unquote(tokens[i++]!.text);
    }
    if (alias === null) alias = `__source_${sources.length + 1}`;
    const source: Source = { alias, name, schema, query, functionSql, join, using: [], natural, on: null };
    sources.push(source);
    // ON expressions can contain nested queries. Only depth-zero boundaries
    // start the next source; USING lists belong to this join.
    while (tokens[i]) {
      const t = tokens[i]!;
      if (t.depth !== 0) { i++; continue; }
      if (clauses.has(t.text.toLowerCase())) return sources;
      if (isKeyword(t, "using") && tokens[i + 1]?.text === "(") {
        const end = close(tokens, i + 1);
        source.using = tokens.slice(i + 2, end).filter((t) => t.text !== ",").map((t) => unquote(t.text));
        i = end + 1;
        continue;
      }
      // ON's expression runs to the next depth-0 boundary: a comma, a JOIN
      // keyword or attribute word, or a top-level clause keyword.
      if (isKeyword(t, "on")) {
        let j = i + 1;
        while (tokens[j] && !(tokens[j]!.depth === 0 && (tokens[j]!.text === "," || clauses.has(tokens[j]!.text.toLowerCase()) || isKeyword(tokens[j], "join") || attributes.has(tokens[j]!.text.toLowerCase())))) j++;
        source.on = sql.slice(tokens[i + 1]?.start ?? t.end, tokens[j]?.start ?? sql.length).trim();
        i = j;
        continue;
      }
      if (t.text === ",") { i++; join = "inner"; natural = false; break; }
      if (isKeyword(t, "join") || attributes.has(t.text.toLowerCase())) {
        const words: string[] = [];
        let j = i;
        while (tokens[j] && attributes.has(tokens[j]!.text.toLowerCase())) words.push(tokens[j++]!.text.toLowerCase());
        if (isKeyword(tokens[j], "join")) {
          join = words.includes("full") || (words.includes("left") && words.includes("right")) ? "full" : words.includes("right") ? "right" : words.includes("left") ? "left" : "inner";
          natural = words.includes("natural");
          i = j + 1;
          break;
        }
      }
      i++;
    }
    if (!tokens[i]) return sources;
  }
}

// Split only TypeScript unions at the outer level; nested JSON object fields
// and literal strings can contain their own vertical bars.
export function unionType(...types: string[]): string {
  return unionMembers(...types).join(" | ");
}

export function unionMembers(...types: string[]): string[] {
  const parts: string[] = [];
  for (const type of types) {
    let start = 0;
    let depth = 0;
    let quote = "";
    for (let i = 0; i <= type.length; i++) {
      const ch = type[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch && "{[(<".includes(ch)) depth++;
      else if (ch && "}])>".includes(ch)) depth--;
      else if (i === type.length || (ch === "|" && depth === 0)) {
        const part = type.slice(start, i).trim();
        if (part && !parts.includes(part)) parts.push(part);
        start = i + 1;
      }
    }
  }
  // A string-literal or numeric-literal member is already assignable to
  // string or number; once the union also carries the bare type, keep
  // only the bare type. A union of literals alone, with no bare string or
  // number member, is untouched (ADR 0098).
  const hasString = parts.includes("string");
  const hasNumber = parts.includes("number");
  if (!hasString && !hasNumber) return parts;
  return parts.filter((part) =>
    !(hasString && /^"(?:[^"\\]|\\.)*"$/.test(part)) && !(hasNumber && /^-?\d+(?:\.\d+)?$/.test(part)));
}
