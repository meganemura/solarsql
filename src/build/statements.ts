// Responsibility: constrain catalog SQL to one statement with its declared role.
// Boundary: SQLite validates the grammar; this scanner identifies the outer verb.
import { isKeyword, significant, splitStatements, tokenize } from "./scan.ts";
import { BuildError } from "./typegen.ts";

export function catalogStatement(sql: string, role: "read" | "plan"): string {
  if (splitStatements(sql).length !== 1) throw new BuildError("Use exactly one SQL statement per catalog entry or plan item.", sql);
  const tokens = significant(tokenize(sql));
  const separator = tokens.findIndex((token) => token.text === ";" && token.type === "punct");
  if (separator >= 0 && tokens.slice(separator).some((token) => token.text !== ";")) {
    throw new BuildError("Use exactly one SQL statement per catalog entry or plan item.", sql);
  }
  const body = separator < 0 ? tokens : tokens.slice(0, separator);
  let at = 0;
  if (isKeyword(body[at], "with")) {
    at++;
    if (isKeyword(body[at], "recursive")) at++;
    for (;;) {
      if (body[at]?.type !== "ident") break;
      at++;
      // Skip a CTE column list or body using the tokenizer's balanced depth.
      const group = (): boolean => {
        if (body[at]?.text !== "(") return false;
        const depth = body[at]!.depth;
        at++;
        while (at < body.length && !(body[at]!.text === ")" && body[at]!.depth === depth)) at++;
        at++;
        return true;
      };
      group();
      if (!isKeyword(body[at], "as")) break;
      at++;
      if (isKeyword(body[at], "not")) at++;
      if (isKeyword(body[at], "materialized")) at++;
      if (!group()) break;
      if (body[at]?.text !== ",") break;
      at++;
    }
  }
  const allowed = role === "read" ? ["select", "values"] : ["select", "values", "insert", "update", "delete", "replace"];
  if (!allowed.some((verb) => isKeyword(body[at], verb))) {
    throw new BuildError(role === "read"
      ? "A query or returns must be SELECT or VALUES, optionally preceded by WITH."
      : "A plan item must be SELECT, VALUES, INSERT, UPDATE, DELETE, or REPLACE, optionally preceded by WITH.", sql);
  }
  // Engine probes wrap SQL in subqueries; omit the terminator and trailing comments.
  return sql.slice(0, body.at(-1)!.end);
}
