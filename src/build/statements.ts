// Responsibility: constrain catalog roles and reject transaction-ending schema conflicts.
// Boundary: SQLite validates the grammar; this scanner recognizes only these fixed shapes.
import { isKeyword, significant, splitStatements, tokenize, triggerBodyBegin } from "./scan.ts";
import { BuildError } from "./build-error.ts";

// These clauses end the transaction that the adapter needs for a command's
// rollback guarantee, even when the command's own statements use plain SQL.
export function refuseTransactionEndingSchemaConflict(sql: string, kind: "table" | "trigger"): void {
  const tokens = significant(tokenize(sql));
  const hasKeywordsAt = (at: number, ...words: string[]): boolean => words.every((word, offset) => isKeyword(tokens[at + offset], word));
  if (kind === "table" && tokens.some((_, i) => hasKeywordsAt(i, "on", "conflict", "rollback"))) {
    throw new BuildError(
      "A schema cannot use ON CONFLICT ROLLBACK: the adapter owns the transaction. Leave the default (ABORT) to get a failure value, or use ON CONFLICT IGNORE, REPLACE, or FAIL when that outcome is intentional.",
      sql,
    );
  }
  if (kind === "table") return;
  if (tokens.some((_, i) => hasKeywordsAt(i, "raise") && tokens[i + 1]?.text === "(" && hasKeywordsAt(i + 2, "rollback") && tokens[i + 3]?.text === ",")) {
    throw new BuildError(
      "A trigger cannot use RAISE(ROLLBACK, ...): the adapter owns the transaction. Use RAISE(ABORT, ...), RAISE(FAIL, ...), or RAISE(IGNORE) instead.",
      sql,
    );
  }
  const bodyBegin = triggerBodyBegin(tokens);
  // A missing body yields only the final token, which cannot form OR ROLLBACK.
  const body = tokens.slice(tokens.indexOf(bodyBegin as (typeof tokens)[number]));
  if (body.some((_, i) => isKeyword(body[i], "or") && isKeyword(body[i + 1], "rollback"))) {
    throw new BuildError(
      "A trigger body cannot use OR ROLLBACK: the adapter owns the transaction. Leave the default (ABORT) to get a failure value, or use OR IGNORE or OR REPLACE when that outcome is intentional.",
      sql,
    );
  }
}

export function catalogStatement(sql: string, role: "read" | "plan"): string {
  if (splitStatements(sql).length !== 1) throw new BuildError("Use exactly one SQL statement per catalog entry or plan item.", sql);
  const tokens = significant(tokenize(sql));
  // splitStatements returned one statement, so significant tokens has a last token.
  const end = tokens.findLastIndex((token) => token.text !== ";") + 1;
  const body = tokens.slice(0, end);
  let at = 0;
  if (isKeyword(body[at], "with")) {
    at++;
    if (isKeyword(body[at], "recursive")) at++;
    for (;;) {
      // SQLite validates CTE grammar; a non-identifier here can only make this scanner stop at the same unsupported verb.
      if (body[at]?.type !== "ident") break;
      at++;
      // Skip a CTE column list or body using the tokenizer's balanced depth.
      const group = (): boolean => {
        // Treating a missing group as present only changes traversal of malformed SQL, which SQLite rejects during prepare.
        if (body[at]?.text !== "(") return false;
        const depth = body[at]!.depth;
        do { at++; } while (at < body.length && body[at]!.depth !== depth);
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
  // ADR 0045 already refuses transaction control in a plan item because the
  // adapter must own the transaction that gives a command its rollback
  // guarantee (ADR 0072). INSERT OR ROLLBACK and UPDATE OR ROLLBACK end that
  // same transaction from inside a statement the adapter cannot classify or
  // catch (ADR 0133), so they are refused here the same way.
  // The read-role verb check above already refuses INSERT and UPDATE before this condition.
  if (role === "plan" && (isKeyword(body[at], "insert") || isKeyword(body[at], "update")) && isKeyword(body[at + 1], "or") && isKeyword(body[at + 2], "rollback")) {
    throw new BuildError(
      "A plan item cannot use OR ROLLBACK: the adapter owns the transaction. Leave the default (ABORT) to get a failure value, or use OR IGNORE to skip a row that fails a uniqueness, NOT NULL, or CHECK constraint (not a foreign key).",
      sql,
    );
  }
  // Engine probes wrap SQL in subqueries; omit the terminator and trailing comments.
  return sql.slice(0, body.at(-1)!.end);
}
