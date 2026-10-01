// Responsibility: describe query scopes after SQLite validates the SQL.
// Boundary: this parser records bindings and join structure, not expression types
// or SQL validity. Unknown source shapes are reported instead of guessed.
import { isKeyword, significant, sqliteName, tokenize, unquote, type Token } from "./scan.ts";

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
// SQLite applies explicit COLLATE operators inside an operand.
// `known` records one trailing operator because its precedence is clear.
// `unknown` records nested or multiple operators because this parser cannot identify SQLite's winning operator.
// `none` lets typegen use declared column precedence.
// Typegen rejects an equality with `unknown` rather than prove a key under the wrong collation.
type ExplicitCollation =
  | { kind: "known"; name: string }
  | { kind: "unknown" }
  | { kind: "none" };

function sideCollation(tokens: Token[]): ExplicitCollation {
  if (isKeyword(tokens.at(-2), "collate") && tokens.filter((token) => isKeyword(token, "collate")).length === 1) return { kind: "known", name: unquote(tokens.at(-1)!.text).toUpperCase() };
  if (tokens.some((token) => isKeyword(token, "collate"))) return { kind: "unknown" };
  return { kind: "none" };
}

// The parser can remove a known suffix without changing which explicit operator wins.
// An unknown operand stays unresolved because removing one operator could expose the wrong column shape.
function sideRef(tokens: Token[]): { alias: string | null; column: string } | null {
  let t = tokens;
  const collate = sideCollation(t);
  if (collate.kind === "known") {
    t = t.slice(0, -2);
  }
  if (t.length === 1 && t[0]!.type === "ident") return { alias: null, column: unquote(t[0]!.text) };
  if (t.length === 3 && t[0]!.type === "ident" && t[1]!.text === "." && t[2]!.type === "ident") return { alias: unquote(t[0]!.text), column: unquote(t[2]!.text) };
  return null;
}

// A column keeps its reference so typegen can read its declared collation.
// A value contributes no declared collation, so SQLite can use the target column's collation.
type EqualityOperand =
  | { kind: "column"; alias: string | null; column: string }
  | { kind: "value" };

// Null marks an expression that is neither a column nor a value.
// A bare column has a null alias, so typegen cannot use table facts to resolve its collation.
// The target side preserves operand order because SQLite checks the left column's declared collation before the right column's.
export type OnEquality = { explicitCollation: ExplicitCollation; other: EqualityOperand | null; targetSide: "left" | "right" };

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

// From one ON or WHERE clause, the columns of `alias` that a depth-0 AND
// chain equates against an expression that does not itself reference
// `alias`. Each result keeps the other operand's classification, the
// operand order, and an explicit COLLATE state. A bare column keeps no
// alias, so typegen cannot resolve its declared collation from table facts.
// Returns null
// when a depth-0 OR sits in the clause: an OR can satisfy the join without
// every conjunct holding for every matched row, the same reasoning
// unconditionalMatchAliases (scan.ts) already applies to WHERE.
// An empty token list also reaches an empty result through the conjunct loop.
// The early return avoids that work without changing the result.
export function onEqualities(on: string, alias: string): Map<string, OnEquality> | null {
  const tokens = significant(tokenize(on));
  if (tokens.length === 0) return new Map();
  if (tokens.some((t) => t.depth === 0 && isKeyword(t, "or"))) return null;
  const out = new Map<string, OnEquality>();
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i !== tokens.length && !(tokens[i]!.depth === 0 && isKeyword(tokens[i], "and"))) continue;
    const conjunct = tokens.slice(start, i);
    start = i + 1;
    const eq = conjunct.findIndex((t) => t.depth === 0 && t.text === "=");
    if (eq <= 0 || eq >= conjunct.length - 1) continue;
    const leftTokens = conjunct.slice(0, eq);
    const rightTokens = conjunct.slice(eq + 1);
    const leftCollation = sideCollation(leftTokens);
    const left = sideRef(leftTokens);
    const right = sideRef(rightTokens);
    const target = left && left.alias !== null && sqliteName(left.alias) === sqliteName(alias) ? { ref: left, other: rightTokens, otherRef: right, targetSide: "left" as const }
      : right && right.alias !== null && sqliteName(right.alias) === sqliteName(alias) ? { ref: right, other: leftTokens, otherRef: left, targetSide: "right" as const }
      : null;
    if (!target || referencesAlias(target.other, alias)) continue;
    const other: EqualityOperand | null = target.otherRef !== null
      ? { kind: "column", alias: target.otherRef.alias, column: target.otherRef.column }
      : target.other.length === 1 && ["param", "string", "number"].includes(target.other[0]!.type)
        ? { kind: "value" }
        : null;
    out.set(sqliteName(target.ref.column), {
      explicitCollation: leftCollation.kind === "none" ? sideCollation(rightTokens) : leftCollation,
      other,
      targetSide: target.targetSide,
    });
  }
  return out;
}

// Each caller selects an opening parenthesis after a name, AS, a hint, USING, or a source separator.
// Starting one token earlier crosses that prefix and reaches the same close in validated SQL.
// The tokenizer keeps tokens inside the pair at greater depth; only its closing parenthesis restores the opening depth.
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
    // SQLite permits compound ORDER BY and LIMIT only after the last arm, so earlier depth-zero tokens cannot be tails.
    // The final arm starts with SELECT or VALUES, so its first token cannot be a tail clause.
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
        // USING and the preceding source token both have depth zero; either cursor reaches the same closing parenthesis.
        const end = close(tokens, i + 1);
        source.using = tokens.slice(i + 2, end).filter((t) => t.text !== ",").map((t) => unquote(t.text));
        // Revisiting the last USING item skips its nested token, then the closing parenthesis advances without changing a source.
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
      // A token outside the join keywords leaves words empty and fails the inner JOIN check, so scanning it has no effect.
      if (isKeyword(t, "join") || attributes.has(t.text.toLowerCase())) {
        // Join classification reads only full, left, right, and natural; any other entry in words has no effect.
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
  // When both bare types are absent, both filter predicates are false and the filter retains every member.
  if (!hasString && !hasNumber) return parts;
  return parts.filter((part) =>
    !(hasString && /^"(?:[^"\\]|\\.)*"$/.test(part)) && !(hasNumber && /^-?\d+(?:\.\d+)?$/.test(part)));
}
