# ADR 0123: `migrate()` names the file that introduced a foreign-key violation

Status: accepted (2026-09-19)

## Context

`migrate()` (`src/durable.ts`) runs `pragma foreign_key_check` at the end of each migration file's own transaction, on Node and on a Durable Object under workerd. An immediate constraint (`NOT NULL`, `UNIQUE`, `CHECK`, or a non-deferred foreign key) always threw synchronously and rolled back only its own file.

A deferred foreign key did not, on a Durable Object. Measured directly against workerd (Miniflare's bundled runtime, the same engine Cloudflare deploys): a deferred foreign-key check does not fire on its own at `transactionSync`'s own RELEASE, only later, at the request's own implicit commit, by which point `migrate()` had already returned normally and the platform discarded the response and reset the object instead of handing the constructor a catchable error. `migrate()`'s own end-of-file `pragma foreign_key_check` closes this: it runs inside the same transaction the file's statements ran in, so a deferred violation surfaces there instead of at the platform's own later commit.

That scan checks the whole database, not only the rows the current file's statements touched, so it can surface a violation a different file, or a different table, wrote earlier while `pragma foreign_keys` was off, or one left over from before this check existed. Blaming the file being replayed for a violation that predates it would misdirect a repair.

A rebuild that adds a foreign key an existing row already violates carries `pragma defer_foreign_keys = on`, so its own check waits until commit instead of failing mid-rebuild. Measured against wrangler 4.127.1's local D1: a direct run of such a rebuild, on a database with an orphaned row, rejected the whole file with exit code 1, and `orders`'s schema and `d1_migrations` read back unchanged afterward, so the rejection rolled back atomically, the same property `db.batch()` on Miniflare's D1 shows. The rejection text was `Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`: SQLite's own constraint text is present, after the platform's own reset-and-rolled-back prefix.

ADR 0117 has `bareMessage()` (`src/runtime/plan.ts`) strip that same platform prefix so `constraintFailure()` can classify the text underneath, but only when a caller passes the message to `constraintFailure()`. Neither `wrangler d1 migrations apply` nor a direct call to the D1 binding's own `batch()` method goes through solarsql's `run()`, so `constraintFailure()` never sees either message. `migrate()`'s own thrown message, `Migration <file>: FOREIGN KEY constraint failed (pragma_foreign_key_check): [...]`, is unclassified for the same reason: its `Migration <file>: ` prefix and `(pragma_foreign_key_check): [...]` suffix both survive `bareMessage()` unstripped. All three messages carry SQLite's own constraint text for a person to read; none of the three is a text `constraintFailure()` resolves.

This is measured for D1's local apply and for a direct `db.batch()` call; the one remote run on record found empty tables and no violation to reject, so a remote apply's own rejection message under a real violation has not been observed the same way.

## Decision

`migrate()` tells apart a violation that already existed before the current file ran from one the file introduced. `violationKeys()` (`src/durable.ts`) keys each row `pragma_foreign_key_check` reports by its table, parent table, referencing and referenced column names, primary-key value, and the current value of the referencing column (or columns); it reads each key before the file runs and again after, and compares the two sets. The referencing column's value is part of the key on its own: a statement that only changes which row a violation points at, with the primary-key value unchanged, still reads as a new violation. When every violation found after the file ran already existed before it ran, `migrate()` throws a plain `Error` whose message contains `predates ${file.name}`, naming the violations in the same shape `pragma_foreign_key_check` itself returns, instead of blaming the file for them; the rollback stays the same, and only this file's own change rolls back.

Reading a primary-key value back this way needs a table with exactly one primary-key column: either a declared type other than `INTEGER`, or a single-column `INTEGER PRIMARY KEY` declared `AUTOINCREMENT` (`migrate()` uses the rowid itself there, since `AUTOINCREMENT` forces every new rowid past `sqlite_sequence`'s own high-water mark, so the same row's rowid is never reused the way a plain `integer primary key`'s can be). On a table with an `INTEGER PRIMARY KEY` with no `AUTOINCREMENT`, a composite primary key, or a `WITHOUT ROWID` table, `migrate()` cannot read a value back this way, so it always blames the named file, even when the violation predates it.

Two edits join a predating violation to the file that merely carries it forward, so `migrate()` blames the file anyway: a migration that renames the violated foreign key's own referencing column (the identity `violationKeys()` reads changes even though the same row still names the same missing parent), and a migration whose statements reassign an `AUTOINCREMENT` row's own rowid (`AUTOINCREMENT` only guarantees a fresh rowid on insert, not that an existing row's rowid stays fixed, so the two readings of that row stop matching).

## Why

The scan has to check the whole database because a deferred violation can come from any table, not only the ones the current file touched; a key narrower than (table, parent, column names, primary-key value, referencing-column value) would either miss a real new violation (rowid reuse after a delete-then-insert) or wrongly call a repointed violation "the same one" (a row whose primary-key value stays put while its referencing column changes). Both failure shapes were reproduced directly against `node:sqlite` before this design was chosen.

Recording the constraint kind is not the same as classifying it: `constraintFailure()` exists to save a caller from reading Cloudflare's own error text by hand, and it can only do that for a message that reaches solarsql's own `run()`. `wrangler d1 migrations apply`, a direct `batch()` call, and `migrate()`'s own thrown message all reach a caller by a path `run()` never sees, so widening `bareMessage()`'s stripping further would not change what these three paths report; the fix for those paths is reading the message text, not a wider strip.

## Evidence

`test/node.test.ts`: the `predates` test suite (around lines 460-870) proves, against `node:sqlite`, that a file which fixes a pre-existing violation and introduces a different one on a reused rowid is not read as the same violation; that a file which only repoints a violation to a different missing parent, with the primary-key value unchanged, is not read as an old one; and that a violation left untouched by an unrelated file reads as `predates`, and one the file itself introduces does not.
`test/miniflare/migrate-durable-object.test.ts:128` reproduces the `predates` message against a real Durable Object under Miniflare.
`test/strict-migration.test.ts`'s orphaned-row commit test reproduces the same `FOREIGN KEY constraint failed` rejection through a raw begin/statement-loop/commit/rollback, matching `diff()`/`render()`'s own rebuild pipeline.
`v0-measurements.md`, section 4c, measures the shape of wrangler's local D1 apply this ADR's Context cites.

## Consequences

- A caller who wants the constraint kind from `wrangler d1 migrations apply`, a direct `batch()` call, or `migrate()`'s own thrown message reads SQLite's own text out of the message directly; `failureClass()` and `constraintFailure()` do not cover these three paths.
- A repair migration whose own statements remove the violating row (for example `delete from child where parent_id = 'missing'`) clears the violation before the end-of-file check runs, so it applies with no error and joins the history normally; a later, unrelated file applies normally after it.
- A project that renames a foreign key's referencing column, or reassigns an `AUTOINCREMENT` row's own rowid, in the same file that carries a pre-existing violation forward, gets a `predates`-free error naming that file; the repair is still to fix the violation, not to read the file as at fault for creating it.
