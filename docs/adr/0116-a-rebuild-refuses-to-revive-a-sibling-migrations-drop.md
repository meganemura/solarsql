# ADR 0116: A rebuild refuses to revive a sibling migration's drop

Status: accepted (2026-09-16)

## Context

ADR 0102 gave a `RebuildRecord` three more fields -- `constraints`, `indexes`, `triggers` -- and had replay compare each against the table's live schema through `unknownDeclaration(recorded, actual)`. That comparison is one-directional: it refuses only when the live schema has an entry the record does not, which is the direction ADR 0099 established for a column and ADR 0102 extended to the other three kinds of declaration.

ADR 0102's own Consequences named the cost of that direction, for its three new kinds:

> The one-directional comparison does not refuse a rebuild whose recorded set has an entry the actual set lacks: when a sibling migration has dropped a table-level constraint, an index, or a trigger that this rebuild's own target schema still declares, replaying this rebuild restores it, with no refusal, because its `CREATE TABLE` and `createLast` statements run from its own target schema, not from the live one. [...] Refusing this direction too is a separate decision, since it would also refuse the ordinary case of a rebuild dropping its own constraint, index, or trigger on purpose; it needs a way to tell "a sibling dropped this on purpose" apart from "this rebuild's own generator saw it dropped," which the current record does not carry.

This decision is that separate decision: the file's own SQL text, at both replay call sites, is the way to tell the two apart, without adding to what `RebuildRecord` carries.

Measured against the real generator and replay functions: branch B drops a table's `UNIQUE(a, b)`, its index, or its trigger; branch A, generated from the schema before B's drop and unaware of it, rebuilds the same table for an unrelated reason and still declares the dropped object. Replaying B then A brings the object back, silently, on both replay paths (`applied()` in `src/build/migration.ts`, `migrate()` in `src/durable.ts`).

## Decision

Both replay paths gain a second, mirror-direction check, run after all five existing checks for a table's rebuild record (the column-unknown check, the column-shape check, and `unknownDeclaration` for constraints, indexes, and triggers). The new check computes `recorded \ actual`: the entries a rebuild's generator saw and recorded, that the live schema no longer has, immediately before this file's own statements run. An entry in that difference is a refusal only when this same migration file's own SQL text redeclares it for the table -- read directly from the file, not from any new field on `RebuildRecord`. An entry in the difference that the file does not redeclare stays allowed, the same intentional-drop case ADR 0099 and ADR 0102 already permit.

A new function, `redeclaredByFile(fileSql, table)` (`src/build/scan.ts`), reads what a file's own statements declare for one table:

- A table-level constraint comes from the file's own `CREATE TABLE "_solarsql_new_<table>"` statement (the name `renamedCreate()`, in `src/build/migration.ts`, always gives a rebuild's fresh copy), through `definitions()`.
- An index or a trigger comes from every `CREATE INDEX`/`CREATE TRIGGER` statement in the file whose own target table -- `indexTarget()`/`triggerTarget()`, already tokenized facts, not a text search -- is this table.

Table-name comparisons in `redeclaredByFile`, like the comparisons the five existing checks already make, are case-insensitive, for the same reason `durable.ts`'s own table lookups are: a `RebuildRecord`'s `table` field and the live table's name are the same SQLite identifier even when their case differs.

A second new function, `revivedDeclaration(recorded, actual, redeclared, byName)`, finds the entry in `recorded \ actual` that `redeclared` also names:

- For an index or a trigger, `byName` is `true`: the match is `created(x)?.name`, not the full text. A sibling's clean drop of `idx1` is still a revival even when this file also edited `idx1`'s own definition since it was recorded (measured: branch A changes its own `idx1` from `on t(c)` to `on t(c, a)`, branch B drops `idx1` outright; the recorded and the redeclared text differ, but the name does not, so only name matching catches it).
- For a table-level constraint, `byName` is `false`: constraints have no name, so the match is exact normalized text, the same limit `unknownDeclaration` already accepts for the forward direction.

The new error code is `REBUILD_REVIVES_DECLARATION`, distinct from `REBUILD_LOSES_COLUMN`: the existing code names the direction where a rebuild would lose a declaration it does not know about; the new one names the mirror direction, where a rebuild would revive one a sibling meant gone. `applied()` throws `BuildError`, which carries no machine-readable code, the same as its five existing checks. The message in both paths names the replaying file, the table, the kind of declaration, an index's or a trigger's name (or a constraint's full normalized text, for want of a name), states that an earlier migration already removed it and this file's own target schema still declares it, and recommends the same repair the five existing checks already recommend: delete the file and regenerate it against the merged schema.

## Why

The one-directional comparison ADR 0099 and ADR 0102 chose is correct for what it already covers: refusing on "recorded but not actual" alone would also refuse the ordinary, legitimate case of a rebuild dropping its own declaration on purpose. What that design did not yet have was a way to tell a sibling's drop, revived by accident, apart from this rebuild's own drop, chosen on purpose. The file's own SQL text already carries that distinction, in both replay call sites, without adding a new field to `RebuildRecord`: what a file's own statements declare for a table is exactly what running that file will leave that table declaring, whether or not the schema those statements were generated against still matches the live one.

## Consequences

- `RebuildRecord`'s own shape (`src/build/scan.ts`) does not change: this decision reads a file's redeclaration from its own SQL text, not from a new recorded field. A migration file `render()` writes is unchanged, byte for byte, from before this decision.
- A table-level constraint's "changed one definition, dropped the other" case remains undetected: branch A changes its own `UNIQUE(a, b)` to `UNIQUE(a, b, c)`, and branch B drops the original `UNIQUE(a, b)` outright. A constraint has no name, so exact-text matching cannot tell A's edit from A's own accidental revival of what B meant to remove. This is the same limit ADR 0102 already accepted for `unknownDeclaration`'s own direction, extended to this mirror direction for the same reason: no bookkeeping short of naming constraints exists to close it.
- An index or a trigger's rename is still indistinguishable from a drop: dropping `idx1` and creating an identically defined `idx2` looks, to a name-based comparison, like an unrelated drop and an unrelated create, not a rename. This is not a new inconsistency this decision introduces: `diff()` itself does not track an index's or a trigger's rename as a rename, the same way `renames`/`drops` intents exist for a column but not for these two kinds of object; the check here inherits that same untracked case.
- The repair this check recommends is the same as `unknownDeclaration`'s: delete the refused file and regenerate it. Regenerating computes the new file's own `current` from the schema as it now stands, after the sibling's drop, so its `RebuildRecord` no longer records the dropped object at all -- there is nothing left in `recorded \ actual` to revive (measured, including the case where the regenerated file itself intentionally re-adds the object: its own generator, run against the post-drop schema, records nothing for it, so nothing here refuses that re-add).
