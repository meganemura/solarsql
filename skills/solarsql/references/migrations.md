# Migrations

## Read this first

- New table or column: [What a migration holds](#what-a-migration-holds).
- Changed column: [What a migration holds](#what-a-migration-holds).
- Dropped table or column: [Remove an ordinary table or column](#remove-an-ordinary-table-or-column).
- Renamed column: [Rename a column without losing its values](#rename-a-column-without-losing-its-values).
- Changed search table: [What a migration holds](#what-a-migration-holds).
- Changed view or trigger: [What a migration holds](#what-a-migration-holds).
- Existing database with no migration history yet: [An existing D1 database](#an-existing-d1-database).
- Rehearse a migration before deploy: [rehearse.md](rehearse.md).
- A replay error naming a `code`: [Migration history integrity](#migration-history-integrity).

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
After renumbering a file that rebuilds a table, run `build --check` again: a rebuild generated before a sibling migration merged in ahead of it may no longer know about every column, shape, constraint, index, or trigger the table now has, and replay refuses it rather than silently losing that data or that declaration (ADR 0099, ADR 0101, ADR 0102). Delete the refused file and run `npx solarsql migration` again against the merged schema.
Replay also refuses the opposite case, where a sibling migration dropped a declaration this file's own target schema still declares (ADR 0116). The repair is the same: delete the file and regenerate it against the merged schema. A rebuild that drops the same declaration on purpose still replays.
Generation rejects a new name that would replay before existing history, including an unsafe digit-width rollover.
Keep applied filenames unchanged when resolving a conflict.
New SQL files use exclusive creation and generation holds `.solarsql-generation.lock` while comparing and writing history.
If another generator holds the lock, retry after it finishes.
If a crash leaves the lock, check that its recorded process has exited before removing it.

## Remove an ordinary table or column

An automatic migration does not remove an ordinary table or column until an
intent file names the exact objects (ADR 0090).

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
rename repair and a command (ADR 0091). Copy the reported JSON into `changes.json`, or
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
| a changed search table | `drop table` then `create virtual table`; the search rows start empty, and only a later write brings a row back through the triggers (ADR 0034). When exactly one `INSERT` trigger on the search table's base keeps to the documented shape (schema.md, "Search tables"), the generator also emits `insert into order_search (order_id, note) select id, note from orders`, right after the create statement; otherwise the create statement carries a comment, and the caller writes that insert (ADR 0118) |
| a removed ordinary table or column | blocked until an exact destructive intent names it |
| a removed ordinary table with a surviving child that has a non-`NO ACTION` delete action | blocked; write an explicit migration that preserves the child rows and foreign keys |
| a removed or changed search table | `drop table` then `create virtual table` when needed |

The order in a file: drop views, drop triggers and indexes, drop tables, change tables, create search tables, create indexes, views, and triggers.
The rebuild check examines incoming references in both schemas, including self-references; cheap ALTER changes remain available.
A trigger in a migration file opens with an uppercase `BEGIN`, whatever the declaration wrote: D1's HTTP API keeps a trigger body whole only then.
Automatic table rebuilds preserve accessible row identifiers when both schema versions have them. If all identifier spellings are shadowed, or a new primary-key alias would change their meaning, generation reports a blocked migration; keep an accessible identifier with the same alias, or write an explicit migration with a data check (ADR 0068). When both versions use AUTOINCREMENT, rebuilds also retain its sequence history, including deleted maximum identifiers (ADR 0070).

## A project where every database starts empty

A test, or a query layer on an in-memory database, applies every migration file to an empty database each time, so the history of files has no reader.
Such a project may keep one file and rewrite it on each schema change: delete `migrations/`, run `npx solarsql migration initial`, then `npx solarsql build`.
A database that a file has reached needs the next file instead: it records the files it applied by name, and a rewritten first file is not applied again. A D1 database after `wrangler d1 migrations apply` is one.

## Files written by hand

The build applies every `.sql` file of the directory in name order to compute the current schema.
A file written by hand can change data or schema; its resulting schema must match the declaration for the final build check.
Name it in the sequence, such as `0005_backfill.sql`, and the next build rewrites `index.ts`.
Test a manual rebuild with representative related rows before deployment; the build compares schemas on empty databases.

## An existing D1 database

A database that already has tables, made by hand or by another tool, has no migration history yet. `wrangler d1 migrations` has `create`, `list`, and `apply` only (wrangler 4.127.1); there is no baseline command. Adopt the database this way:

1. Export the deployed DDL:

   ```sh
   npx wrangler d1 export <database> --remote --no-data --output schema.sql
   ```

   This command fails with `cannot export databases with Virtual Tables (fts5)` when the database already has an FTS5 search table. Read that schema by another means first, such as `select sql from sqlite_schema`, and write its search table into `module.ts` by hand.

2. Write `module.ts` by hand from `schema.sql`, one module per owner, following the STRICT and primary-key rules in `schema.md`. Match `schema.sql` exactly for now, including a table that is not STRICT; do that rebuild as a later migration, not inside the baseline. `wrangler d1 export` writes its own `d1_migrations` table into `schema.sql` once a database has applied a migration; a database with no history yet has none. Omit `d1_migrations` from `module.ts` regardless: it is wrangler's bookkeeping table, not a declared one.

3. Build the project:

   ```sh
   npx solarsql build
   ```

   The build also declares `solarsql_assert`, a table and trigger every solarsql schema carries; `schema.sql` never has it. Expect this one difference in the check below.

4. Generate the baseline file:

   ```sh
   npx solarsql migration initial
   ```

5. Apply the generated file to an empty database:

   ```sh
   sqlite3 check.sqlite < migrations/0001_initial.sql
   ```

6. Load `schema.sql` into its own database, so it can be compared the same way as `check.sqlite`:

   ```sh
   sqlite3 schema.sqlite < schema.sql
   ```

7. Compare the two schemas. Both sides drop any `sqlite_`-prefixed object (an autoindex, or `sqlite_sequence` from AUTOINCREMENT: SQLite names and orders these the same way on both databases, so dropping them from both sides keeps the comparison symmetric). `check.sqlite` also drops `solarsql_assert` and its trigger (the one difference from step 3); `schema.sqlite` also drops `d1_migrations` (present once the exported database has history):

   ```sh
   diff <(sqlite3 check.sqlite "select sql from sqlite_schema where name not in ('solarsql_assert', 'solarsql_assert_check') and name not like 'sqlite_%' order by name") <(sqlite3 schema.sqlite "select sql from sqlite_schema where name not in ('d1_migrations') and name not like 'sqlite_%' order by name")
   ```

8. `d1_migrations` does not exist on a database with no history. Create it, with no files pending, so the next step's insert has a table to write to:

   ```sh
   npx wrangler d1 migrations apply <database> --remote
   ```

9. Record the baseline file as applied, without running it. `d1_migrations` has `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`), `name` (`TEXT UNIQUE`), and `applied_at` (`TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`); the insert needs only `name`:

   ```sh
   npx wrangler d1 execute <database> --remote --command "insert into d1_migrations (name) values ('0001_initial.sql')"
   ```

10. Confirm nothing is pending; `apply` matches by name, not by content:

    ```sh
    npx wrangler d1 migrations list <database> --remote
    ```

11. Check the project once more:

    ```sh
    npx solarsql build --check
    ```

    It passes. The next schema change gets `0002_...`, generated and applied the usual way.

This path cannot prove that every replica of the deployed schema equals the one declared in `module.ts`, only the one `schema.sql` captured. It also cannot prove what `d1_migrations`'s history was before the baseline: that history is now the baseline file, trusted, not verified.

## Check a deployed schema against the declaration

```sh
npx wrangler d1 export <database> --remote --no-data --output deployed.sql
sqlite3 deployed.sqlite < deployed.sql
for f in migrations/*.sql; do sqlite3 check.sqlite < "$f"; done
```

Compare `check.sqlite` and `deployed.sqlite` the way step 7 of "An existing D1 database" compares `check.sqlite` and `schema.sqlite`: the same `diff` pair, the same dropped-object filters.

This comparison cannot show row data, table statistics, or a replica other than the one that answered the export request.

## Applying

### One schema path per database

On D1, `wrangler d1 migrations apply` is the only schema path, local and remote.
`migrate()` (from `solarsql/node`, and from `solarsql/durable` for a Durable Object) is for node:sqlite tests and for Durable Objects.
Never apply both to one database: each keeps its own history table, and the second one re-creates tables the first one made.
For a local seed, open wrangler's local sqlite file (deploy.md, "Develop locally", names the path) with `node()` and write data only; the schema comes from wrangler.

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

A migration applied this way that adds a foreign key an existing row violates fails inside `migrate()` itself, the same as it already did on node:sqlite: `migrate()` runs `pragma foreign_key_check` at the end of each file's own transaction and throws a catchable error naming the violation when it finds one, so the constructor's `blockConcurrencyWhile` rejects and only that file rolls back. This closes a gap on a Durable Object under workerd, where a deferred foreign-key check otherwise fires only at the request's own implicit commit, after `migrate()` already returned (ADR 0123).
On Node, this check runs the same way when `migrate()` is called with no caller-owned transaction already open; when the caller already opened one before calling `migrate()`, the check is skipped and the deferred foreign-key check still fires at the caller's own commit instead, unchanged (`running.md`'s caller-owned-transaction composition).
`pragma foreign_key_check` scans every foreign key in the database, not only the ones the current file's own statements touch, so it can surface a violation a different file or table left behind.

`migrate()` tells apart a violation that predates the file from one the file introduced, by comparing each violated row's primary-key value and referencing-column value before and after the file runs (ADR 0123). This needs a table with one primary-key column, either a non-INTEGER type or a single-column INTEGER PRIMARY KEY declared AUTOINCREMENT; on any other primary-key shape, `migrate()` always blames the named file. Renaming the violated foreign key's referencing column, or reassigning an AUTOINCREMENT row's own rowid, also makes `migrate()` blame the file even when the violation predates it.

When every violation found after the file ran already existed before it ran, `migrate()` throws a plain `Error` (not the `MigrationHistoryError` below) whose message contains `predates`, embedding the violation in the same row shape `pragma foreign_key_check` itself returns, such as `{"table":"child","rowid":1,"parent":"parent","fkid":0}` for a `child` row whose `parent_id` no longer names a row in `parent`. A repair migration file's own statements can remove the violating row directly:

```sql
-- 0001_repair.sql
delete from child where parent_id = 'missing';
```

Passing this file to `migrate()` removes the violation before the end-of-file check runs, so it applies with no error and joins the history as `0001_repair.sql`. A later, unrelated file applies normally after it: the block does not carry forward past the repair.
Confirm this against your own deployment with the remote test (`deploy.md`) before relying on it.
Query `pragma foreign_key_check` yourself, on the same database, before generating or applying a migration, if you want to rule out a pre-existing violation ahead of time (running.md's Adapters section shows the one-line raw SQL call for each target -- D1, Durable Object, Node -- that reaches past the generated queries and commands to do this).

A rebuild that adds a foreign key an existing row already violates carries `pragma defer_foreign_keys = on`, so the file's own foreign-key check waits until commit instead of failing mid-rebuild.
On D1, wrangler's local apply sends one `batch()` per file (v0-measurements.md, section 4c), the same shape `src/d1.ts` uses for a command's own `db.batch()` call.
A migration that fails this way rolls back atomically: the schema and `d1_migrations` (or `solarsql_migrations`) read back unchanged. The rejection carries SQLite's own constraint text, but `wrangler d1 migrations apply`, a direct `batch()` call, and `migrate()`'s own `pragma_foreign_key_check` message all reach a caller without going through `constraintFailure()` (ADR 0123); read the constraint kind from the message text directly.

On node:sqlite, `migrate(db, migrations)` from `solarsql/node` applies the pending files once, in name order, and records each; it returns the names applied now.

There is no down migration. A change back is the next migration.

## Migration history integrity

The Node and Durable Object runners require the full ordered file history.
They store the applied SQL and reject changed contents, missing files, duplicate names, and a new file before an applied file.
An error has `name: "MigrationHistoryError"`, a `code`, and the relevant `migration` name when available.
Restore the applied files and append a new file to repair changed contents, a missing file, or an out-of-order file.
A duplicate name is a caller error, not a history conflict: list each migration file once.
A file runs in one transaction on node:sqlite; transaction control statements inside files are rejected.
On a Durable Object under workerd, and on Node with no caller-owned transaction already open, `migrate()` checks foreign keys itself at the end of each file's transaction: see Applying, above, for what that check does and when it is skipped.

An older database can have name-only history. The runner rejects it with `LEGACY_HISTORY` before new migrations execute.
After checking the original files against your deployment records and database, call `migrate(db, files, { adoptLegacyHistory: true })` once.
Use the same option with Durable Object storage. This records the supplied SQL as a trusted baseline; it cannot prove the original SQL.
Subsequent calls compare exact SQL, including comments and whitespace.
D1 migrations applied through wrangler retain wrangler's history behavior; this check does not wrap that workflow.

`REBUILD_LOSES_COLUMN` and `REBUILD_REVIVES_DECLARATION` come from `migrate()` itself, which checks rebuild safety against the applied database, separately from the static check in `build --check`.

| code | Fix |
|---|---|
| `DUPLICATE_MIGRATION` | List each migration file once. |
| `MIGRATION_TRANSACTION` | Remove transaction control statements. |
| `MISSING_MIGRATION` | Supply the full history. |
| `MIGRATION_ORDER` | Append a new file instead. |
| `LEGACY_HISTORY` | Verify the legacy files before using adoptLegacyHistory. |
| `MIGRATION_CHANGED` | Restore the file and append a new migration. |
| `REBUILD_LOSES_COLUMN` | Regenerate the file against the current schema. |
| `REBUILD_REVIVES_DECLARATION` | Regenerate the file against the current schema. |

Rehearse a migration against a snapshot of real data before you deploy it: [rehearse.md](rehearse.md).
