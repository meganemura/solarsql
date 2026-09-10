# Migrations

```
npx solarsql migration <name>
```

The command writes `migrations/NNNN_<name>.sql` with the difference between the migration files applied in order and the declared schema, and rewrites `migrations/index.ts`, the same files as one module for a Durable Object.
`npx solarsql build` refuses to pass while the files and the schema differ, and prints the statements the migration would hold.
Every build keeps `index.ts` in step with the `.sql` files.

## What a migration holds

| Change | Statements |
|---|---|
| a new table, index, view, trigger, or search table | `CREATE ...` |
| a new column with a default, or nullable | `alter table t add column ...` |
| a new `not null` column without a default | refused; give it a default |
| a table that both loses and gains a column | refused; two migrations, one per change |
| a changed column, constraint, or foreign key; a dropped column; a new stored generated column on a table with rows | a rebuild: `create table t_new`, `insert into t_new select <common columns> from t`, `drop table t`, `alter table t_new rename to t`, inside one transaction, with `pragma defer_foreign_keys = on` first |
| a changed view or trigger | `drop` then `create` |
| any rebuild | every view is dropped first and created last, because a rename under a view fails |
| a changed search table | `drop table` then `create virtual table`; the search rows start empty and come back through the triggers or a re-insert |
| a removed object | `drop ...` |

The order in a file: drop views, drop triggers and indexes, drop tables, change tables, create search tables, create indexes, views, and triggers.
A trigger in a migration file opens with an uppercase `BEGIN`, whatever the declaration wrote: D1's HTTP API keeps a trigger body whole only then.

## A project where every database starts empty

A test, or a query layer on an in-memory database, applies every migration file to an empty database each time, so the history of files has no reader.
Such a project may keep one file and rewrite it on each schema change: delete `migrations/`, run `npx solarsql migration initial`, then `npx solarsql build`.
A database that a file has reached needs the next file instead: it records the files it applied by name, and a rewritten first file is not applied again. A D1 database after `wrangler d1 migrations apply` is one.

## Files written by hand

The build applies every `.sql` file of the directory in name order to compute the current schema, so a file written by hand is fine when it changes no schema: a data backfill, an `update`, a `delete`. Name it in the sequence, `0005_backfill.sql`, and the next build rewrites `index.ts`.

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
