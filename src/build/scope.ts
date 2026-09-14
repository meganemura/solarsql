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
};
export type QueryScope = { ctes: Cte[]; branches: string[]; operators: string[] };
export const sqliteName = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

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
    const source: Source = { alias, name, schema, query, functionSql, join, using: [], natural };
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
