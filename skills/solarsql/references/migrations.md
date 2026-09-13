# Migrations

```
npx solarsql migration <name>
```

The command writes `migrations/NNNN_<name>.sql` with the difference between the migration files applied in order and the declared schema, and rewrites `migrations/index.ts`, the same files as one module for a Durable Object.
`npx solarsql build` reports pending or blocked migrations after generating types; `npx solarsql build --check` fails while the files and schema differ.
Every build keeps `index.ts` in step with the `.sql` files.

Generation appends after the highest numeric sequence, including gaps.
History names use at least four digits followed by `_name.sql`; sequences must be unique and increase in filename order.
Generation rejects a new name that would replay before existing history, including an unsafe digit-width rollover.
Keep applied filenames unchanged when resolving a conflict.
New SQL files use exclusive creation and generation holds `.solarsql-generation.lock` while comparing and writing history.
If another generator holds the lock, retry after it finishes.
If a crash leaves the lock, check that its recorded process has exited before removing it.

## Remove an ordinary table or column

An automatic migration does not remove an ordinary table or column until an
intent file names the exact objects. This prevents a DDL edit from silently
discarding data on a database that has rows.

Create `changes.json` with this strict version-one shape:

```json
{
  "version": 1,
  "drops": [
    { "kind": "column", "table": "orders", "column": "obsolete_note" },
    { "kind": "table", "table": "retired_orders" }
  ]
}
```

Then run:

```sh
npx solarsql migration remove_obsolete_orders --intent changes.json
```

The strings are SQLite object names. Do not add SQL quotes. A table named
`order.lines` remains one `table` string, and a column named `old.value`
remains one `column` string. The generator quotes these names in SQL.

The file must have only `version` and `drops`. Its version is `1`. Each entry
must be a `table` with `table`, or a `column` with `table` and `column`. List
every ordinary removal once. The generator rejects a duplicate, an object that
the schema does not remove, and an omitted removal. It also rejects malformed
JSON before it imports the project configuration.

`build` reports the blocked objects, the JSON to copy, and a runnable
migration command. `build --check` writes no files. A rename declaration
consumes its source column, so that source does not need a drop entry.

Search tables remain derived indexes. Their existing drop-and-create behavior
does not use this intent file.

An automatic removal also stops when a surviving child table has an incoming
foreign key with `ON DELETE CASCADE`, `SET NULL`, `SET DEFAULT`, or `RESTRICT`.
`DROP TABLE` can change child rows or fail because of that action. Write an
explicit migration that preserves the required rows and foreign keys.

## What a migration holds

| Change | Statements |
|---|---|
| a new table, index, view, trigger, or search table | `CREATE ...` |
| a new column with a default, or nullable | `alter table t add column ...` |
| a new `not null` column without a default | refused; give it a default |
| a table that both loses and gains a column | refused; two migrations, one per change |
| a changed column, constraint, or foreign key; a dropped column; a new stored generated column on a table with rows | a rebuild: create the new table, copy common columns into a side table, drop the original, rename the new table, restore rows, then drop the side table; one transaction with `pragma defer_foreign_keys = on` first |
| a rebuild referenced through ON DELETE CASCADE, SET NULL, SET DEFAULT, or RESTRICT | blocked; write an explicit migration that preserves related rows and foreign keys |
| a changed view or trigger | `drop` then `create` |
| any rebuild | every view is dropped first and created last, because a rename under a view fails |
| a changed search table | `drop table` then `create virtual table`; the search rows start empty and come back through the triggers or a re-insert |
| a removed ordinary table or column | blocked until an exact destructive intent names it |
| a removed ordinary table with a surviving child that has a non-`NO ACTION` delete action | blocked; write an explicit migration that preserves the child rows and foreign keys |
| a removed or changed search table | `drop table` then `create virtual table` when needed |

The order in a file: drop views, drop triggers and indexes, drop tables, change tables, create search tables, create indexes, views, and triggers.
The rebuild check examines incoming references in both schemas, including self-references; cheap ALTER changes remain available.
A trigger in a migration file opens with an uppercase `BEGIN`, whatever the declaration wrote: D1's HTTP API keeps a trigger body whole only then.

## A project where every database starts empty

A test, or a query layer on an in-memory database, applies every migration file to an empty database each time, so the history of files has no reader.
Such a project may keep one file and rewrite it on each schema change: delete `migrations/`, run `npx solarsql migration initial`, then `npx solarsql build`.
A database that a file has reached needs the next file instead: it records the files it applied by name, and a rewritten first file is not applied again. A D1 database after `wrangler d1 migrations apply` is one.

## Files written by hand

The build applies every `.sql` file of the directory in name order to compute the current schema.
A file written by hand can change data or schema; its resulting schema must match the declaration for the final build check.
Name it in the sequence, such as `0005_backfill.sql`, and the next build rewrites `index.ts`.
Test a manual rebuild with representative related rows before deployment; the build compares schemas on empty databases.

## Applying

On D1, wrangler applies the files and records each in `d1_migrations`:

```sh
npx wrangler d1 migrations apply <database> --remote
```

On a Durable Object, the constructor applies them once, in name order, and records each in the storage:

```ts
import { migrate } from "solarsql/durable";
import { migrations } from "./migrations/index.ts";

ctx.blockConcurrencyWhile(async () => {
  migrate(ctx.storage, migrations);
});
```

On node:sqlite, `migrate(db, migrations)` from `solarsql/node` does the same, and returns the names applied now.

There is no down migration. A change back is the next migration.

## Migration history integrity

The Node and Durable Object runners require the full ordered file history.
They store the applied SQL and reject changed contents, missing files, duplicate names, and a new file before an applied file.
An error has `name: "MigrationHistoryError"`, a `code`, and the relevant `migration` name when available.
Restore the applied files and append a new file to repair a history conflict.
A file runs in one transaction; transaction control statements inside files are rejected.

An older database can have name-only history. The runner rejects it with `LEGACY_HISTORY` before new migrations execute.
After checking the original files against your deployment records and database, call `migrate(db, files, { adoptLegacyHistory: true })` once.
Use the same option with Durable Object storage. This records the supplied SQL as a trusted baseline; it cannot prove the original SQL.
Subsequent calls compare exact SQL, including comments and whitespace.
D1 migrations applied through wrangler retain wrangler's history behavior; this check does not wrap that workflow.

## Rehearse with existing data

```sh
npx solarsql rehearse local.sqlite proposed.sql checks.json
```

The command opens the source read-only and uses SQLite backup to create a disposable snapshot, including committed WAL data.
It applies the proposed SQL to the snapshot in one transaction and checks database integrity and foreign keys.
It blocks database attachments. It deletes the snapshot on completion or failure.
The versioned JSON result includes before/after row counts, completed checks, and failure diagnostics. Exit 1 indicates failure.

The optional `checks.json` has two maps of names to SQL:

```json
{
  "queries": { "oldRead": "select id, value from items where id = :id" },
  "assertions": { "retained": "select count(*) = 20 from items" }
}
```

Queries compile before and after the change; result column names and declared types must match.
This detects structural incompatibility, not every semantic or nullability change.
Assertions execute after migration and must each return one row with one value equal to 1. They take no parameters.
Use assertions for application-specific data requirements. Row counts alone do not prove value preservation.
The command rehearses proposed SQL, not migration history adoption or a remote deployment.

For a slow local snapshot, run `node spike/11-backup-lifecycle.ts` from a source checkout.
It measures each backup phase, checks WAL rows and implicit row identities, and stops after 20 seconds (ADR 0063).

The rehearsal CLI has a 30,000ms default time budget, including startup and snapshot creation.
Use `--timeout-ms 120000` when the workload needs a larger finite budget.
A deadline produces exit 1 and `REHEARSAL_TIMEOUT` after the parent removes its snapshots.
Inspect the workload before increasing the budget. The source database remains unchanged.
This deadline applies to the CLI; the in-process `rehearse` function does not cancel native backup.

Automatic table rebuilds preserve accessible row identifiers when both schema versions have them.
If all identifier spellings are shadowed, or a new primary-key alias would change their meaning, generation reports a blocked migration.
Keep an accessible identifier with the same alias, or write an explicit migration with a data check (ADR 0068).
When both versions use AUTOINCREMENT, rebuilds also retain its sequence history, including deleted maximum identifiers (ADR 0070).
