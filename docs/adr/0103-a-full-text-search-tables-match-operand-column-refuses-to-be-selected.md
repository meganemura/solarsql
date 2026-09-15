# ADR 0103: A full-text search table's match-operand column refuses to be selected

Status: accepted (2026-09-15)

## Context

A `CREATE VIRTUAL TABLE ... USING fts5(...)` table has a hidden column named after the table itself (`create virtual table f using fts5(body)` gives a column named `f`). SQLite's own FTS5 documentation describes this column as the right-hand side of the `MATCH` operator, and as the first argument of `highlight()`, `snippet()`, and `bm25()`; it is not one of the table's declared text columns.

`Typer.column()` (`src/build/typegen.ts`) types this column unconditionally as `{type: "string", nullable: false}`, with the comment that "the column named after the table is the match target, which takes the query string." This exists for one caller path: `paramType()` -> `ofRef()` -> `column()`, which types a `MATCH` clause's right-hand parameter (`select body from f where f match :q` correctly types `:q` as `string`).

The same `column()` also runs for every ordinary output column, so when a query selects this hidden column directly (`select f from f`, `select f as x from f`), it gets the same `string`, non-null type. What SQLite actually returns there is not a string: measured directly, `typeof rows[0].f === "number"`, every row of one statement execution returns the same value, and a different statement execution returns a different value. What that integer represents is not established here; SQLite's own documentation names this column's two legitimate uses (a `MATCH` operand, and `highlight()`/`snippet()`/`bm25()`'s first argument) but does not describe the value returned when it is read as an ordinary column, and no claim beyond the three measurements above is made.

The generated TypeScript expects `string`; the value at run time is a number neither `tsc` nor the build catches — a false success that reaches only a caller reading the row's field at run time.

## Decision

Selecting a full-text search table's own hidden match-operand column, directly, now fails at build time. `column()` itself does not change; its `string`/non-null answer for this column stays correct for `MATCH` parameter typing, which is out of scope here.

Two independent call paths reach an output column with this shape, so the refusal is added in two places, both delegating to one shared message (`Typer.matchOperandRefusal()`):

- `outputColumn()`'s `out.table && out.column` branch, which resolves a RETURNING item's bare column reference directly from SQLite's own prepared-statement metadata.
- `sourceRows()` tags this one column, when its table is virtual and the column's name equals the table's name, with a new `ScopeColumn.matchOperandOf` field carrying the table's name. `branchRows()` checks this tag immediately after `scopedReference()` resolves a bare or table-qualified column reference in a SELECT, before it reads the resolved column's type. Because `nullableColumn()` spreads its input rather than replacing it, the tag survives a LEFT JOIN's outer-side nullable wrapping, so the refusal still fires there.

## Why

A value with no meaning on a row gets no type; it gets a refusal, the same logic ADR 0100 already applied to a RETURNING clause with no way to type its expression. Here the value does have a storage class SQLite reports (`SqlValue`'s `"number"`), but claiming a specific TypeScript type for it would assert something about its meaning this ADR's own investigation could not establish.

## Consequences

- `select body from f where f match :q` is unaffected: `:q` still types `string`, because `MATCH` parameter typing goes through `paramType()` -> `ofRef()` -> `column()`, a path this decision does not touch.
- `select highlight(f, 0, '<', '>') as h from f where f match :q` is unaffected: `f` there is an argument inside a function call, not a bare column reference, so it never reaches `out.table && out.column` or `scopedReference()`'s bare-column match; that query already failed with "column \"h\" is an expression with no type. Wrap it in cast(...)" before this change, for an unrelated reason, and still does.
- `select rank from f` is unaffected: `rank`'s name differs from the table's own name, so neither the `outputColumn()` check nor the `matchOperandOf` tag applies to it.
- `select * from f` is unaffected: SQLite's wildcard expansion does not include a hidden column, so this column never appears in a `*` expansion's output list.
- This refusal has two implementation sites, not one, because a SELECT's bare column reference and a RETURNING clause's bare column reference resolve through two different mechanisms in this file. A SELECT's bare column reference resolves inside `branchRows()`'s query-scope walk (`scopedReference()`) and returns before `outputColumn()` ever runs; RETURNING's bare column reference reaches `outputColumn()` directly, because SQLite's own prepared-statement column metadata already names its table and column. Both sites share one message through `matchOperandRefusal()`, so the two paths cannot drift into different wording for what is the same refusal.
