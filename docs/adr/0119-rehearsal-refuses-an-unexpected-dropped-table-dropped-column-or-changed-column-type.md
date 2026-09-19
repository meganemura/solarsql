# ADR 0119: Rehearsal refuses an unexpected dropped table, dropped column, or changed column type

Status: accepted (2026-09-19)

## Context

`rehearseSnapshot()` (`src/build/rehearse.ts`) compares each table's row count before and after the proposed SQL runs. A migration that drops a column keeps every row, so the row-count check passes and the result reports `ok: true`. A migration that drops a whole table removes it from `after`; nothing compares the two table sets. The build-time refusals ADR 0099, ADR 0101, ADR 0102, and ADR 0116 give already catch a stale generated rebuild, by comparing against a recorded declaration. They do not cover a hand-written migration file, or a rebuild file generated before those checks existed: neither carries a record to compare against. Rehearsal is the last local check before a deployment, and until now it approved a column loss silently.

## Decision

The result gains `columns: { before, after }`, one `Column[]` per table already listed by the row-count comparison: `{ name, type, notnull, pk }`, read with `select name, type, "notnull", pk from pragma_table_xinfo(?) where hidden in (0, 2, 3) order by cid`. `pragma_table_xinfo` also answers for a search table (a virtual table); the two extra `hidden` values keep its own visible text and UNINDEXED columns, and drop its hidden index bookkeeping.

After the migration runs and `healthy(db)` passes, a new stage, `SCHEMA_SHAPE_CHANGED`, compares `columns.before` and `columns.after`:

- a table in `before` missing from `after` is a dropped table;
- a column in a table's `before` list missing from its `after` list, matched by name case-insensitively, is a dropped column;
- a column whose `type` differs, case-insensitively, between the two lists is a changed column type.

An added table or an added column is never a finding: an addition cannot lose data a caller relied on. A rename is indistinguishable from a drop and an add together; this check does not try to tell them apart, the same limit ADR 0116 already accepted for an index or a trigger's rename.

Each finding fails the rehearsal unless `checks.json` names it in a new `expected` field:

```json
{ "expected": { "dropped": [{ "table": "retired" }, { "table": "orders", "column": "obsolete_note" }], "retyped": [{ "table": "orders", "column": "qty" }] } }
```

`validateChecks` validates `expected` the same way it validates `queries`, `assertions`, and `cases`: only `dropped` and `retyped`, each an array of objects with a `table` string and, for `dropped`, an optional `column` string, or for `retyped`, a required `column` string; no other keys. An `expected` entry the migration does not actually produce is also a failure, naming the entry, so a `checks.json` written for one migration cannot excuse an unrelated later loss. The failure message lists every unexpected finding and every unmatched `expected` entry together, `table.column` per item, so the caller sees them all at once instead of one at a time across repeated runs.

The new stage runs right after `healthy(db)`/`counts()` and before `QUERY_COMPATIBILITY_FAILED`, keeping every existing stage name and order. The row-count comparison is unchanged.

`version` stays `1`. The added `columns` result field and the added optional `expected` checks field are both compatible with a reader written against the old shape: an old reader that does not look at `columns` or send `expected` keeps working exactly as before.

## Why

Row counts alone do not prove a table's shape survived a migration; they only prove existing rows were not deleted. `pragma_table_xinfo` is the same fact source the build's own generator already trusts (ADR 0099 and after), read fresh from the snapshot both before and after the proposed SQL runs, so a hand-written migration or a pre-existing rebuild file gets the same shape guarantee a build-time check already gives a freshly generated one. Requiring `expected` to name an intentional loss, rather than a flag that turns the whole stage off, keeps the check specific to what a reviewer actually saw when they read the migration; a stale entry that matches nothing anymore fails loudly instead of quietly protecting a future, different loss.

## Consequences

- A migration that drops a column or a table, or narrows a column's declared type, now fails rehearsal unless the caller reviews it and lists it in `expected`. This is a deliberate, expected behavior change for any existing `checks.json` used against such a migration; the fix is to add the finding to `expected`, not to work around the check.
- A renamed column still needs the caller to read the migration and list it under `expected.dropped`, since a drop and an add together and a rename look identical from `columns.before`/`columns.after` alone.
- The comparison reads only `pragma_table_xinfo`'s own reported name, type, `notnull`, and `pk`; it does not compare a default value, a CHECK constraint, an index, or a trigger, all of which stay outside this stage's own scope.
