# ADR 0142: a generated migration is replayed before it is written, and a view's triggers move with the view

Status: accepted (2026-10-02).

## Context

The migration diff dropped and recreated views without their triggers. Measured with node:sqlite 3.53.4, on a schema with a table `t`, a view `v` on `t`, and an `INSTEAD OF INSERT` trigger on `v`:

- A rebuild of `t` dropped `v` before the rebuild and created it again after (a rename under a view fails), but never created the trigger again. `DROP VIEW` drops the triggers on that view, so the database lost the trigger, and every insert through `v` failed with "cannot modify v because it is a view".
- A changed view with no rebuild lost its trigger the same way.
- A changed trigger on an unchanged view gave only `CREATE TRIGGER`, which failed with "trigger already exists". The diff skipped `DROP TRIGGER` for any trigger whose table was missing from the target's tables, and a view is never among the tables.
- A trigger removed from an unchanged view gave an empty plan. The build then said the migrations were current while the replayed schema still had the trigger.

`solarsql migration` wrote the plan to a file without applying it, so nothing checked that the file reaches the declared schema. `build --check` replays the files and diffs again, so it caught the first case once the file existed, but a second diff of the same two schemas cannot see the last case.

## Decision

- A view that a plan drops takes its triggers with it, so the plan creates each of those triggers again after the view. A view counts as gone only when the plan drops it. A changed or removed trigger on a kept view gets its own `DROP TRIGGER`, the same as a trigger on a kept table. Tables and views match a trigger's or an index's table under SQLite's identifier case rule, because an ON clause can spell the name in another case, and `shape()` compares a trigger's table the same way.
- `migrationStatus` replays the result before `build`, `build --check`, or `migration` uses it. It renders the generated statements as the file text `migration` would write, appends that text to the existing files, applies them all through `applied()` the way a database applies them, and compares `shape()` of the result with the declared schema's. It runs for an empty plan too, where the existing files alone must reach the declared schema.
- When the shapes differ, the build stops with an error that names each object that differs and says to write the next migration by hand. `migration` writes no file, and the commands exit 1. A statement that fails during the replay is reported the way `applied()` reports any replay failure, with the generated migration named as its file.
- `requireReplayReachesTarget` in `src/build/migration.ts` is the seam. A test hands it a plan with one statement removed and reaches the refusal.

A second diff after the replay was refused as the check: it compares the same objects the first diff compared, so it repeats the first diff's blind spots. `shape()` compares every table, index, trigger, view, and search table that `introspect()` reads.

## Consequences

- A gap in the diff now stops the build before a file exists, instead of shipping a file that loses or keeps a declaration.
- The replay costs one more pass of `applied()` over the migration files for each status. Measured on the example's five files: about 2 ms; on 330 files over 30 tables, applied() takes about 250 ms a pass, so the replay about doubles the status time.
- A trigger that a sibling migration adds on a view is outside the rebuild record; ADR 0143 adds a separate view record that `applied()` and `migrate()` check.
