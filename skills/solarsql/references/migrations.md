# Migrations

```
npx solarsql migration <name>
```

The command writes `migrations/NNNN_<name>.sql` with the difference between the migration files applied in order and the declared schema, and rewrites `migrations/index.ts`, the same files as one module for a Durable Object.
`npx solarsql build` reports pending or blocked migrations after generating types; `npx solarsql build --check` fails while the files and schema differ.
Every build keeps `index.ts` in step with the `.sql` files.

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
| a removed object | `drop ...` |

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
