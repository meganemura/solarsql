# ADR 0146: a statement-breakpoint line follows each generated statement

Status: accepted (2026-10-17).

## Context

Void (the `void` package, measured at 1.1.11) deploys a Vite app to Cloudflare and applies the hand-written files in `db/migrations/*.sql` to D1 itself. It needs no Drizzle schema for this, and it records each applied file by name.
Before it applies a file, its classifier (`classifySqlMigration` in `@void/deploy-core` 1.1.11) puts the file in one of three kinds:

- `breakpoint-framed`: the file has a `--> statement-breakpoint` line outside a literal. Void splits the file at each such line and runs the parts as one D1 batch.
- `single-statement`: the file splits on `;` into one statement. Void runs it as one prepared statement.
- `legacy-unsplit-multi-statement`: every other file. Void splits it on `;` when it can. When the file has a `BEGIN` or `TRIGGER` token, it cannot, and Void sends the whole file to D1 `exec()`.

D1 `exec()` runs each line as a statement. On Miniflare's D1, `exec()` of `create table b (\n  id text\n);` failed with `incomplete input`.
Every initial solarsql migration has a trigger, `solarsql_assert_check`, and the triggers and tables of a generated file span several lines. So Void classified every such file as `legacy-unsplit-multi-statement` and the deploy failed. Measured on the example's own files: `0001_initial.sql`, `0003_views_and_triggers.sql`, `0004_search.sql`, and `0005_customer_name_not_empty.sql` are `legacy-unsplit-multi-statement`; `0002_orders_customer_id.sql` is `single-statement`.

Void's own guide gives the same rule for a hand-written file with a trigger: a `--> statement-breakpoint` line after each complete statement, a trigger's closing `END;` included.

## Decision

`render()` writes a `--> statement-breakpoint` line after each statement, the last one included.
The header lines stay before the first statement, and a file with no statement is unchanged.
The files already in `example/migrations/` stay as they are.

## Rejected alternatives

- The line only between statements. A file that holds one trigger then has no line, and Void classified it as `legacy-unsplit-multi-statement`: its `;` count is more than one, because of the `;` inside the trigger body.
- The line before the first statement. Void would then send the header comments alone as one statement of the batch.
- Void's `-- void:allow-unsplit-multi-statement` line. In Void 1.1.11 it changes no execution path, and the file still goes to `exec()`.
- A setting that turns the line on for a Void project. The line is an SQL comment, so every other reader of the file reads the same statements with it. A setting would add a choice with no effect elsewhere.
- Rewriting the committed files of `example/migrations/`. A Durable Object stores the text of each file it applied and refuses a changed file (`MIGRATION_CHANGED`).
- Writing `-- void:allow-destructive` into a destructive file. That line is Void's permission for a destructive file. A person gives it after reading the file, so solarsql does not write it.

## Why

The line is a comment for SQLite, so the other readers needed no change, and each was run on generated files with the line:

- `splitStatements()` gives the same statements. A Hegel property in `test/render-migration.test.ts` checks this for lists that hold trigger bodies and literals with `;` and the line itself.
- `migrate()` on node:sqlite and the build replay (`applied()`) apply a generated trigger migration and a one-trigger migration.
- `solarsql build --check`, `solarsql rehearse`, and `wrangler d1 migrations apply --local` (wrangler 4.127.1) accept a fresh initial migration and a rebuild of the example.

Void's classifier put both files in `breakpoint-framed`, with 13 and 9 statements. Each statement list ran as one batch on Miniflare's D1, the way Void runs it, and so did a one-trigger file.

## Consequences

- Generated migration files carry one more line per statement.
- A Void project can use solarsql's generated files with no edit, apart from the `-- void:allow-destructive` line that a destructive file needs.
- A file generated before this decision, or written by hand, still needs the lines added by hand before a database applies it on Void.
