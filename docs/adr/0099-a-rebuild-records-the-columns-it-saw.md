# ADR 0099: A table rebuild records the columns it saw, and replay refuses an unknown one

Status: accepted (2026-09-15)

## Context

A table rebuild (`src/build/migration.ts`) copies only the columns its target and its current schema shared at generation time.
Two branches can each generate a migration for the same table independently: one branch rebuilds the table for an unrelated reason, the other adds a plain column.
Merged, with the plain addition applied first and the rebuild renumbered after it, the rebuild's copy statement does not know the new column exists.

Two variants follow from this, both reproduced against the real generator and replay functions.
First, the rebuilding branch never declared the new column at all: the rebuilt table ends up without it, and `no such column` is the first sign, after the data is already gone.
Second, the rebuilding branch happened to add the same column, under the same name, for its own reasons: the rebuilt table keeps the column, but the copy statement does not carry the value forward, so every existing row's value silently becomes `NULL`.
Neither variant raises an error at generation time, because `dropIntentPlan` (ADR 0090) only reviews a column present in the rebuilding branch's own current schema and absent from its own target; a column neither branch's generation step knew about is invisible to it.

`build`'s full-history replay-and-diff (`migrationStatus`) does not catch this after the fact either.
It compares the final replayed state to the final declared schema, so an ordinary forgotten `ADD COLUMN` and a `NULL`-ed or lost column from a stale rebuild produce the same "migration pending" message.
The tool's own suggested repair for the first case, generating a new migration that adds the column, also resolves the second: it makes `build --check` report the schema in sync again, with the original data already gone.

## Decision

A migration file that rebuilds a table records, in a comment line `render()` writes into the file, the exact column names `tableStatements` used to compute that rebuild's copy list — the columns the generator saw for that table, not the columns it decided to keep.
Before a rebuild statement runs, replay introspects the table's actual current columns and refuses if any of them is absent from the recorded list, naming the migration file, the table, the column, and the earlier migration file that added it.
This is a subset check, not an equality check: a table that has fewer columns now than the generator saw (because an earlier file in this same replay already dropped one) is not an error; a table that has a column the generator never saw is.

The check runs once per rebuilding file, before any of that file's statements execute, so a refusal never leaves a partially applied rebuild to roll back.
It replaces neither existing error path: `dropIntentPlan` still requires an exact declared intent for every column a branch's own generation step can see is being removed, and this check catches only what that step could not see.

The check applies in two places, because a migration file can reach a real database through either path: `applied()` (`src/build/migration.ts`), the full-history, build-time replay `build`, `build --check`, and `migration` all run before a file is deployed; and `migrate()` (`src/durable.ts`), the incremental, runtime replay a Durable Object actually executes. The parser for the recorded comment lives in `src/build/scan.ts`, the module both already import, so neither replay path needs a second implementation of it.

A migration file with no recorded comment — every file `render()` wrote before this decision, and every file with no rebuild in it — replays exactly as it did before: unchecked, not refused.
The check protects a history generated from this point on; it does not retroactively review a rebuild already on disk.

## Why

The generator cannot see a concurrently generated sibling's schema; no comparison at generation time closes that gap.
The information that closes it — which columns a specific rebuild actually accounted for — exists only once, at the moment `tableStatements` builds the copy list, and is gone by the time the file is merged with anything else.
Recording it in the file is the only way replay, later and elsewhere, can tell "this rebuild never knew about this column" apart from "this rebuild is fine, and a sibling simply has not been merged yet."
A subset check, rather than a flag naming the specific hazard, needs no new case for the two variants above: an unknown column is unknown whether the rebuilt table ends up missing it or ends up with it and no value for it, because in both cases the generator's own recorded list is what the copy statement was built from.

## Consequences

- `render()`'s output changes only for a migration that rebuilds a table: it gains one comment line naming the columns the generator saw for that table. A migration with no rebuild is unchanged, byte for byte.
- `applied()`'s message names one repair: delete the file and run `solarsql migration` again against the merged schema. Its replay always runs before any database has the file, so there is only ever one repair to name. `migrate()`'s message names the loss it prevented instead, because that function's replay is the live database: the file it just refused is, by construction, one no earlier file in its own history left unapplied.
- D1 applies migration files through `wrangler`, which does not run solarsql or this check. `build --check`, run before a merge reaches D1, is what protects a D1 deployment; a Durable Object is protected a second time, at `migrate()`, because that function is solarsql's own code running against the real database.
- A project with a rebuild already generated before this decision ships replays it unchanged; the project is protected starting with its next generated rebuild, not retroactively.
- A cheap-ALTER migration (`alter table t add column x`, `alter table t drop column x`) needs no recorded columns and gets none: its statements are static and never depend on any other column the table has, so it is safe against a sibling's unknown column by construction. Only a rebuild, which recreates the table from a schema snapshot, needs this record.
- The check compares the rebuilt table's actual columns against what the generator saw; it does not compare the rebuilt table's actual *shape* against a later target. Two branches that each rebuild the same table for unrelated reasons (one drops NOT NULL on one column, the other drops it on a different column) touch no unknown column in either file, so this check passes for both, and the second-replayed rebuild's `CREATE TABLE` silently reverts the first rebuild's change. This is the same underlying hazard one level up — a rebuild's `CREATE TABLE` is generated from a schema snapshot, not only its copy statement is — and needs a separate decision, not a fix folded into this one.
