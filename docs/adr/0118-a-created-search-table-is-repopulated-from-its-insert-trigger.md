# ADR 0118: A created search table is repopulated from its insert trigger

Status: accepted (2026-09-19)

## Context

ADR 0034 gave a search table (`CREATE VIRTUAL TABLE ... USING fts5`) no ALTER: a change drops it and creates it again, and a new one starts with no rows. Either way, its trigger only fires on a later write; a row already in the indexed table stays out of search until the migration also inserts it. `skills/solarsql/references/migrations.md`'s row "a changed search table" already told a caller to write that insert by hand. A caller who forgets gets no error: the table builds, the migration applies, and every pre-existing row is silently unsearchable.

The generator already has what it needs to write that insert for the common case. The documented search-table pattern (schema.md, "Search tables") keeps a search table in step with one `AFTER INSERT` trigger whose body is one `insert into <search> (<cols>) values (new.<col>, ...)`. That trigger already names, in order, which search column takes which base column's value. Reading it back gives `insert into <search> (<cols>) select <cols of base> from <base>`.

## Decision

`diff()` (`src/build/migration.ts`) emits the repopulation insert, right after a created search table's own `create virtual table` statement, only when the target schema's triggers meet all of these conditions for that search table:

1. Exactly one trigger has an `INSERT` event and writes into the search table (`BEFORE INSERT` and `AFTER INSERT` both qualify; `INSTEAD OF` does not, since an `INSTEAD OF` trigger sits on a view, not a table with rows of its own).
2. Between `ON <base>` and `BEGIN` there is nothing but an optional `FOR EACH ROW`. A `WHEN` clause disqualifies the trigger.
3. The trigger's body is exactly one statement: `insert into <search> (<c1>, ..., <cn>) values (<e1>, ..., <en>)`, with the same count on both sides.
4. Every `<ei>` is exactly `new.<column>` -- three tokens, an identifier, a dot, and an identifier. Any other expression (`upper(new.note)`, a literal, `coalesce(...)`) disqualifies the trigger.
5. The trigger's base is a table of the target schema, not a view.

Two new functions in `src/build/scan.ts` read these facts from a trigger's own SQL text, with no SQL parser (ADR 0020): `triggerInsertTarget(triggerSql)` gives the search table and the base a trigger's `INSERT` body writes into, without judging the body's shape, so `diff()` can count how many triggers write into a given search table before it looks closer at any one of them; `searchFill(triggerSql)` gives the full shape -- the search table, its columns in the trigger's own column-list order, the matching `new.<column>` sources, and the base -- or `null` when a trigger fails any of conditions 2 through 4.

When a created search table has no shape that meets all five conditions -- more than one candidate trigger, a `WHEN` clause, a non-`new.<column>` expression, or a base that is a view -- its `create virtual table` statement instead gets a leading comment naming the gap:

```
-- order_search starts empty. No single INSERT trigger with only new.<column> values names how to fill it. Add an insert that repopulates it from its base table.
create virtual table order_search using fts5(...)
```

`splitStatements()` already strips a statement's own comments before every applier (node, a Durable Object's `migrate()`, wrangler) runs it, and SQLite itself never records a leading comment in a `CREATE` statement's own stored text, so the create statement each applier runs, and what a second `diff()` sees afterward, is unchanged either way -- measured against `node:sqlite`: a `CREATE VIRTUAL TABLE` executed with a leading `--` comment records the same `sqlite_schema.sql` as the same statement without one.

A removed search table gets nothing new: there is no created `create virtual table` statement for a comment or an insert to attach to.

## Evidence

`test/search-migration.test.ts`: a changed search table with the documented trigger gets the insert, placed between the `create virtual table` and the trigger's own `create trigger`, and the pre-existing row in its base table is searchable after apply; a new search table on a base table that already has rows behaves the same way; a trigger with an expression other than `new.<column>`, a `WHEN` clause, two candidate triggers, and no trigger at all each leave the create statement with the comment instead, with zero rows after apply and an empty second `diff()`; `searchFill`'s and `triggerInsertTarget`'s own unit cases cover quoted identifiers, `BEFORE INSERT`, `FOR EACH ROW`, mixed-case keywords, and a trigger `searchFill` refuses that `triggerInsertTarget` still counts; a deterministic loop over column-list sizes 1 through 4 builds a base table, a search table, and the matching trigger, and checks that every base row survives into the search table after apply.

## Consequences

- ADR 0034's "a later write brings a row back through the triggers; an existing row returns only when the migration also inserts it" now needs an insert from the caller only in the comment case. The documented trigger shape (schema.md, "Search tables") repopulates itself.
- A trigger that computes its search text (`upper(new.note)`, `coalesce(new.note, '')`, a second trigger for the same search table, or a `WHEN` clause) still needs a hand-written insert: the generator does not guess an expression's semantics, and reports the gap through the comment instead of silence.
- Two update-then-insert triggers, the shape schema.md's own `orderSearchUpdate` example shows for keeping a search table in step with an update, are outside this decision's scope: only an `INSERT` trigger's body is read. A search table maintained only through such a trigger still needs a hand-written repopulation insert, marked by the same comment.
