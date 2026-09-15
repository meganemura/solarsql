# ADR 0104: A full-text search table's rank column types as non-null under a provable MATCH

Status: accepted (2026-09-15)

## Context

`Typer.column()` (`src/build/typegen.ts`) types a full-text search table's `rank` column unconditionally as `{type: "number", nullable: true}`, with the comment that rank can be null without `MATCH`. Measured directly against `node:sqlite`'s FTS5:

- `select rank from f` (no `MATCH` clause) returns a row with `rank: null`.
- `select rank from f where f match 'alpha'` returns a row with `rank` always a non-null number (for example `-0.000001`).

The second case still typed as `number | null`: safe (it asserts nothing false), but imprecise.

A first rule was considered and rejected: "non-null whenever a depth-0 `<alias> match <expr>` appears anywhere in the WHERE clause." Measured against SQLite, this rule is unsound. The query

```sql
select rowid, rank from f where rowid = 2 or f match 'alpha'
```

both prepares and executes successfully, and returns a real row, `{rowid: 2, rank: null}`, for a row where `f match 'alpha'` does not hold. A depth-0 `match` token alone does not prove that every returned row satisfied it; an `OR` can let an unmatched row through.

Two more shapes were measured to check the split-on-`and` approach does not introduce a different unsoundness. `where not (f match 'alpha')` prepares, then fails at execution with `Error: unable to use function MATCH in the requested context`; a `NOT`-wrapped `MATCH` can never itself produce a wrongly-typed row, because the query never returns a row at all. `where rowid between 1 and f match 'alpha'` — where the `and` belongs to `BETWEEN`, not to a conjunction — also fails at execution with the same "unable to use function MATCH" error, for the same reason: `BETWEEN`'s upper bound is not a context where `MATCH` is permitted. A splitter that treats every depth-0 `and` as a conjunct separator therefore never types a row that SQLite would actually return.

## Decision

A new `unconditionalMatchAliases(sql)` (`src/build/scan.ts`) reads a statement's WHERE clause, splits it on its depth-0 `and` tokens, and returns the set of aliases for which some conjunct's first two tokens are exactly an identifier followed by `MATCH`. If a depth-0 `or` appears anywhere in the clause, the function returns the empty set for the whole clause, rather than trying to reason about which conjuncts an `OR` does or does not protect.

`sourceContext()` (`src/build/typegen.ts`) computes this set once per statement, from the full SQL text it already holds, and passes each source's membership into a new `matched` parameter on `sourceRows()`. `sourceRows()` uses `matched` only to drop the `| null` it would otherwise add to a virtual table's own `rank` column. `column()` itself, and `MATCH` operand parameter typing (`select body from f where f match :q`'s `:q`), are unchanged; `sourceRows()` runs per table scan and did not previously have access to the enclosing SELECT's WHERE clause, which is why the decision lives in `sourceContext()`, the caller that does.

## Why

This is a safe under-approximation, the same design this project applies elsewhere: a shape it does not recognize keeps the nullable type it already had, and it never asserts non-null for a row that could in fact be null.

## Consequences

- `where (a or b) and f match :q` is recognized as non-null: the `OR` is inside parentheses, at depth 1, so the depth-0 disqualification does not apply, and the `f match :q` conjunct is still found correctly.
- `where f match :q or (x=1 and y=2)` is not recognized: the `OR` is at depth 0, so the whole clause is disqualified, even though this particular `OR`'s left branch already requires the match.
- A conjunct wrapped in its own parentheses (`where (f match :q)`), and a qualified `<alias>.<column> match` form, are conservatively not recognized: a safe loss of precision, not a soundness gap.
- A `MATCH` in a `JOIN ... ON` clause is not recognized, because only the WHERE clause is examined: `select rank from t left join f on f match :q` and `select rank from t join f on f match :q` — an INNER JOIN, where every returned row is in fact matched — both keep `rank` as `number | null`. This is a known, safe loss of precision, not planned as follow-up work here.
- `where rowid between 1 and f match 'alpha'` can split into `["rowid between 1", "f match 'alpha'"]`, wrongly recognizing the second piece as its own conjunct; but this exact shape fails at execution (see Context), so no row with a wrongly-typed `rank` can ever come from it. `where rowid between 1 and 2 and f match :q` — an ordinary, valid `BETWEEN` — splits into `["rowid between 1", "2", "f match :q"]`, and the last piece is still recognized correctly; the split lands on the right conjunct only by coincidence, but the result is correct all the same.
