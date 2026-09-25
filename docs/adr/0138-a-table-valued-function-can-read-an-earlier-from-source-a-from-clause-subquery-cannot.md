# ADR 0138: a table-valued function can read an earlier FROM source; a FROM-clause subquery cannot

Status: accepted (2026-09-25).

## Context

Two FROM-list shapes reached the build with a raw engine message and no rule.

**A table-valued function's argument can name an earlier FROM source's column.** `select o.id, j.value as tag from orders o, json_each(o.tags) j` runs on node:sqlite, local D1 (batch), and a local Durable Object (transactionSync), all on Miniflare -- measured 2026-09-25. The build refused it with `no such column: o.tags`, because `sourceRows` (typegen.ts) typed a table-valued function source by preparing `select * from <function call>` alone, with no earlier FROM alias in scope.

A second, nested case is the set-based way to insert children for many parents in one statement: `... from json_each(:orders) o, json_each(o.value -> 'lines') l`. This also runs on all three engines. Typing it needs the source columns above, plus a parameter type for `:orders` that nests `l`'s own keys (`sku`, `qty`, `price`) under `lines`, not at `:orders`'s own top level. That second part is scan.ts's `jsonKeys`, which scanned the whole SQL text for `alias.value ->> 'k'` with no per-alias scope: every such key found, from every `json_each` in the statement, landed on the one bound parameter.

**A FROM-clause subquery cannot read an earlier FROM item's column.** `select o.id, x.id as lid from orders o, (select id from order_lines l where l.order_id = o.id limit 2) x` fails prepare with `no such column: o.id` on node:sqlite, local D1, and a local Durable Object alike -- measured 2026-09-25. Unlike a scalar or EXISTS subquery, which SQLite correlates to the enclosing query, a FROM-clause subquery is its own closed scope; this is not a gap in the build, it is SQLite's own rule for this shape.

## Decision

`sourceRows`'s table-valued-function branch now probes with every earlier FROM alias in scope: an `alias.column` reference to one is replaced with the literal `null` before the probe (the same substitution `detachedProbe` already makes for a parent query's own alias), so the probe still only asks the engine for the function's own output columns. This also covers a non-JSON table-valued function, such as `pragma_table_info(t.name)`, with no separate fixed-column table to maintain.

`jsonKeys` (scan.ts) now scopes a key to the `json_each` alias that owns it. A FROM list with two table-valued functions must qualify every `value` (SQLite refuses a bare, ambiguous one), so a qualified occurrence belongs to the `json_each` known by that qualifier, not to whichever one `jsonKeys` was asked about; an occurrence qualified with a different alias is skipped. A `json_each`'s own alias also gathers, by the insert's own column-list position, the keys an insert-select's own SELECT list reads for it (`chainedJsonSources`, `insertSelectShape`, `selectListKeysForAlias`), and, when a second `json_each` chains off its own element (a sole argument reading `<alias>.value -> 'key'` or `->> 'key'`), that second `json_each`'s own key set nested under the key that names it (`nestedKeysForAlias`), recursively for a chain more than one level deep. `jsonKeyType` (typegen.ts) renders that nesting as one `readonly { ... }[]` per level.

A nested `json_each` reading another `json_each`'s own `.value` through any other function-argument shape -- a JSON path argument (`json_each(o.value, '$.lines')`), a second argument, or any other expression -- still cannot be typed this way, and is refused: `chainedJsonEachKeyRefusal` (typegen.ts) names the shape and the workaround.

A FROM-clause subquery reading an earlier FROM item's column is refused with a message naming the rule (`correlatedFromSubqueryRefusal`, typegen.ts), in place of the engine's own `no such column` text. The message does not contain the words "no such column": `columnsHint` (build.ts) appends a "columns of `<table>`" hint to any message that does, which would be misleading here, since the reader's fix is not to pick a different column but to move the condition into a JOIN's own ON clause, or into a scalar or EXISTS subquery.

Both refusals reuse `querySources` (scope.ts) to find each FROM item's own alias and, for a derived-table source, its own SQL text; neither needs a new scanner fact.

A `queries()`/`returns` entry reached `correlatedFromSubqueryRefusal` and `chainedJsonEachKeyRefusal` too late to show either: build.ts's own read-only precheck, which also prepares the statement (`engine.accesses`, to find a write it must refuse), ran before `typer.analyze`, so a statement either refusal would have caught surfaced as the engine's own raw prepare error instead. `typer.analyze` now runs first for every statement, command plan item and `queries()`/`returns` entry alike, so both kinds reach the same refusal for the same SQL.

## Consequences

- `json_each`/`json_tree`/a scalar table-valued function reading an earlier FROM source's column now types SqlValue, unless a follow-up gives fixed columns to json_each/json_tree specifically.
- A FROM-clause subquery correlated to an earlier FROM item fails the build with a message naming the rule and its remedy, not a bare engine message, whether it sits in a command's plan or in a `queries()`/`returns` entry.
- A `json_each` chained off another `json_each`'s own element, through a sole `<alias>.value -> 'key'` (or `->>`) argument, now types: the outer parameter nests the chained `json_each`'s own keys under the key that names it. Any other function-argument shape that reads the same element still fails the build; the message names the workaround (a second, flattened array parameter, the parent id repeated on each child).
