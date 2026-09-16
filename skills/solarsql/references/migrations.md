# Migrations

```
npx solarsql migration <name>
```

The command writes `migrations/NNNN_<name>.sql` with the difference between the migration files applied in order and the declared schema, and rewrites `migrations/index.ts`, the same files as one module for a Durable Object.
Before it writes a file, the command runs every check `build` runs, so a module-boundary violation, or another reason `build` would refuse, blocks generation instead of only surfacing on a later `build --check` (ADR 0096).
`npx solarsql build` reports pending or blocked migrations after generating types; `npx solarsql build --check` fails while the files and schema differ.
Every build keeps `index.ts` in step with the `.sql` files.

Generation appends after the highest numeric sequence, including gaps.
History names use at least four digits followed by `_name.sql`; sequences must be unique and increase in filename order.
Two branches that each generate the next file independently can collide on the same sequence number; `build`/`build --check` refuse that before merge, and if both files are already applied somewhere, the repair is a new migration that reconciles them, not a rename.
After renumbering a file that rebuilds a table, run `build --check` again: a rebuild generated before a sibling migration merged in ahead of it may no longer know about every column that table now has, a known column's current declared shape, or a table-level constraint, an index, or a trigger the table now has, and replay refuses it rather than silently losing that data or that declaration (ADR 0099, ADR 0101, ADR 0102). Delete the refused file and run `npx solarsql migration` again against the merged schema; it regenerates the rebuild with full knowledge of the current columns.
Replay also refuses the opposite case. A sibling migration dropped a table-level constraint, an index, or a trigger. This file's own target schema still declares it, so replaying it would bring that declaration back (ADR 0116). The repair is the same: delete the file and regenerate it against the merged schema. A rebuild that drops the same declaration on purpose still replays.
Generation rejects a new name that would replay before existing history, including an unsafe digit-width rollover.
Keep applied filenames unchanged when resolving a conflict.
New SQL files use exclusive creation and generation holds `.solarsql-generation.lock` while comparing and writing history.
If another generator holds the lock, retry after it finishes.
If a crash leaves the lock, check that its recorded process has exited before removing it.

## Remove an ordinary table or column

An automatic migration does not remove an ordinary table or column until an
intent file names the exact objects. This prevents a DDL edit from silently
discarding data on a database that has rows.

Create `changes.json` with this strict version-one shape. Keep both lists,
even when one list is empty:

```json
{
  "version": 1,
  "drops": [
    { "kind": "column", "table": "orders", "column": "obsolete_note" },
    { "kind": "table", "table": "retired_orders" }
  ],
  "renames": []
}
```

Then run:

```sh
npx solarsql migration remove_obsolete_orders --intent changes.json
```

The strings are SQLite object names. Do not add SQL quotes. A table named
`order.lines` remains one `table` string, and a column named `old.value`
remains one `column` string. The generator quotes these names in SQL.
Match the declared DDL spelling exactly, including its case; SQLite itself treats two differently cased identifiers as the same name, but this intent file does not.

The file must have only `version`, `drops`, and `renames`. Its version is `1`.
Each drop entry must be a `table` with `table`, or a `column` with `table` and
`column`. List every ordinary removal once. The generator rejects a duplicate,
an object that the schema does not remove, and an omitted removal. It also
rejects malformed JSON before it imports the project configuration.

## Rename a column without losing its values

When a table loses one column and gains one column, the build reports an exact
rename repair and a command. Copy the reported JSON into `changes.json`, or
write this shape yourself:

```json
{
  "version": 1,
  "drops": [],
  "renames": [
    { "table": "orders", "from": "old_note", "to": "note" }
  ]
}
```

Run the command with the same custom configuration path when there is one:

```sh
npx solarsql migration rename_note --intent changes.json solarsql.config.ts
```

Each rename entry has only `table`, `from`, and `to` strings. The names are
logical SQLite identifiers, so dots remain part of one value and need no SQL
quotes. The generator rejects unknown fields, a missing source or target,
duplicate, conflicting, chained, or unused declarations. It writes `ALTER
TABLE ... RENAME COLUMN ...` before safe additions and preserves the renamed
values and row identifiers.
Match the declared DDL spelling exactly, including its case; SQLite itself treats two differently cased identifiers as the same name, but this intent file does not.

An exact column drop in `drops` may share the same migration with a declared
rename and a safe nullable addition. The drop does not become another rename.

For several removed and added columns, the build lists the source and target
candidate sets. Choose the one-to-one mapping in `renames`, or split the
change into separate migrations. The generator does not choose that mapping.

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
| a table that both loses and gains a column | blocked until `renames` gives each data-preserving mapping; split an ambiguous multi-column change when needed |
| a changed column, constraint, or foreign key; a dropped column; a new stored generated column on a table with rows | a rebuild: create the new table, copy common columns into a side table, drop the original, rename the new table, restore rows, then drop the side table; one transaction with `pragma defer_foreign_keys = on` first. A row that violates the new declaration -- NOT NULL, UNIQUE, CHECK, or a foreign key -- fails the restore insert, or fails at commit for a deferred foreign key; either way the whole rebuild rolls back |
| a rebuild referenced through ON DELETE CASCADE, SET NULL, SET DEFAULT, or RESTRICT | blocked; write an explicit migration that preserves related rows and foreign keys |
| a changed view or trigger | `drop` then `create` |
| any rebuild | every view is dropped first and created last, because a rename under a view fails |
| a changed search table | `drop table` then `create virtual table`; the search rows start empty, and only a later write brings a row back through the triggers (ADR 0034). A row already in the indexed table stays out of search until the migration also inserts it, for example `insert into order_search (order_id, note) select id, note from orders` |
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
Restore the applied files and append a new file to repair changed contents, a missing file, or an out-of-order file.
A duplicate name is a caller error, not a history conflict: list each migration file once.
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
Assertions execute after migration and must each return one row with one value equal to 1. They take no parameters: a named or anonymous parameter in an assertion is refused, instead of running with the unbound value SQLite would otherwise silently use (ADR 0106).
Use assertions for application-specific data requirements. Row counts alone do not prove value preservation.
The command rehearses proposed SQL, not migration history adoption or a remote deployment.

A query check compares result columns only; it does not execute the query.
A migration can keep the same columns and still break stored data, for example when it turns a JSON column into plain text.
Add a `cases` map to `checks.json` to run a representative old query with real parameters and catch this:

```json
{
  "cases": {
    "reader": {
      "sql": "select json_extract(payload, '$.id') as id from items where id = :id",
      "params": { ":id": 1 }
    }
  }
}
```

Each case is one read statement (SELECT or VALUES, WITH allowed) with named parameters; an anonymous `?` parameter is rejected.
A `params` key is the full name written in the SQL, prefix included (`:id`, `@id`, or `$id`), not the bare name (`id`).
This matches the prefix that Node's adapter itself binds by, and it stops two parameters that share a bare name under different prefixes from colliding.
A string, a finite number, or null binds as itself.
A boolean is rejected at the top level: no generated query parameter is ever a boolean, because SqlValue has none. Use 0 or 1 instead.
An array or an object binds as its JSON text, readable through `json_extract`, `json_each`, and similar functions. A boolean nested inside one still binds correctly, because JSON itself has a boolean.
A BLOB (`Uint8Array`) or a BigInt has no JSON representation and is rejected; encode it as a string instead.

The command runs every case before the migration and again after it, inside the same rehearsal.
Both runs must execute without error, and the result columns must still match, or the rehearsal fails.
This is stronger than a query check: a case proves the statement still executes against real rows, not only that its column shape is unchanged.
A successful case is reported by name only; its SQL, parameters, and rows never appear in the result.
A successful case does not prove that the returned values are equal before and after the migration, and it does not prove compatibility with a remote D1 database or Durable Object.

| The message contains | Fix |
|---|---|
| `takes no parameters, but uses` | bind real values with a case instead |
| `must be a finite number` | use a finite number |
| `is a BigInt` | bind it as a string instead |
| `is a BLOB` | bind it as a string instead |
| `has unknown field` | use only `sql` and `params` |
| `uses an anonymous parameter` | name every slot |
| `more than one prefix` | use one prefix per bare parameter name |
| `is missing parameter` | supply a value for every named slot the SQL uses |
| `has unexpected parameter` | remove a param key the SQL does not use |
| `is a boolean` | bind 0 or 1 instead |
| `Result columns changed for case` | the case's result shape changed across the migration; treat this the same as a query check's shape mismatch |

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
