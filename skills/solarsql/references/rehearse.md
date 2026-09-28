# Rehearse a migration with existing data

Rehearse a proposed migration before you deploy it, whenever a target database already has rows.
It proves the migration applies to a snapshot of that data, and fails by default when a row is lost or changed unexpectedly (see `result.rows` and [Declare an intended row loss](#declare-an-intended-row-loss) below). It does not prove a remote D1 database or a Durable Object accepts the same SQL.

```sh
npx solarsql rehearse local.sqlite proposed.sql checks.json
```

The command opens the source read-only and uses `vacuum into` to write a disposable snapshot, including committed WAL data (ADR 0121).
It applies the proposed SQL to the snapshot in one transaction and checks database integrity and foreign keys.
The proposed SQL and every check run under an authorizer that blocks database attachments; only after they have all run does the command attach its own before-copy, under its own narrower authorizer, to compute `result.rows` (ADR 0139). It deletes the snapshot and the before-copy on completion or failure when the operating system permits removal. `TEMP_CLEANUP_FAILED` names a remaining temporary path and the removal error without changing `result.ok`.
The versioned JSON result includes before/after row counts, before/after column lists, a per-table row diff, completed checks, and failure diagnostics. Exit 1 indicates failure.

`result.rows` reports, per table, how many rows were inserted, deleted, and updated, by primary key, against a before-copy taken with the working connection's own `vacuum into` (ADR 0139). A row is "updated" when a common column's value or storage class differs (`upper()` on a `COLLATE NOCASE` column, or an integer retyped to a real, both count). Matching is by primary key and by column name, case-insensitively; a `NOCASE` primary key matches keys case-insensitively. A table with no primary key, or whose primary-key columns changed, reports `{ "compared": false, "reason": "..." }` instead of counts. A virtual table (for example, an FTS5 table) and its own shadow tables never appear in `result.rows`. A table present on only one side (dropped, or newly created) does not appear either -- see `result.columns` for that.

A rowid table can store NULL in a non-`INTEGER` primary-key column; matching treats two NULLs as the same key, so a row that keeps a NULL primary key reports no change. If more than one row shares the same NULL-inclusive primary key, that table reports `compared: false` instead of counts, since rows cannot be matched unambiguously.

## Declare an intended row loss

A rehearsal fails when a compared table shows `deleted > 0` or `updated > 0`, or when a `compared: false` table has fewer rows after the migration than before, unless `checks.json` declares the table intended. A same-size or growing `compared: false` table is not flagged: its contents cannot be verified either way. Declare an intentional table with `expected.deleted` and `expected.updated`, alongside `expected.dropped` and `expected.retyped`:

```json
{
  "expected": {
    "deleted": [{ "table": "sessions" }],
    "updated": [{ "table": "customers" }]
  }
}
```

Each entry names only `table`: a lost or rewritten row is never scoped to one column the way a dropped or retyped column is. `expected.retyped` on a column excuses only the type change itself: a row whose retyped column keeps the same value once SQLite's own comparison affinity is applied (an integer retyped to the text of the same number) is not "updated" on that column's account, with no separate `expected.updated` entry needed for it. A row whose retyped column's value actually changed -- wiped to NULL, a lossy cast (1.5 to 1), a botched `cast()` -- still counts as updated and still needs `expected.updated`, the same as any other column; `expected.retyped` never excuses `deleted`, and never a different column's own change on the same row. This exemption compares under binary collation regardless of the column's own declared collation, so a case change or a trailing-whitespace change on a `NOCASE`- or `RTRIM`-collated retyped column still counts as updated too. It also excuses a retype that drops information SQLite's own comparison affinity treats as equal: `'007'` retyped to the integer `7` compares equal (leading zeros are not significant to a number), so a zip code or a phone number column kept as digits-only text should declare `expected.updated`, not rely on `expected.retyped` alone, if the rebuild can drop a leading zero this way. A declared table where the migration produced no matching loss is a stale entry and fails, the same as `expected.dropped` or `expected.retyped`.

`result.columns.before` and `result.columns.after` list, per table, each column's `name`, declared `type`, `notnull`, and `pk`, read from `pragma_table_xinfo`. After the migration runs and the database passes its integrity and foreign-key checks, the command compares the two lists. A table present before and missing after, a column present before and missing after (matched by name, case-insensitive), or a column whose type differs (case-insensitive) is a finding. An added table or an added column is never a finding. The comparison does not detect a rename: a rename shows up as one dropped column and one added column.

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

A finding fails the rehearsal unless `checks.json` names it as expected:

```json
{
  "expected": {
    "dropped": [{ "table": "retired" }, { "table": "orders", "column": "obsolete_note" }],
    "retyped": [{ "table": "orders", "column": "qty" }]
  }
}
```

A dropped table names only `table`. A dropped column, or a retyped column, names both `table` and `column`. An `expected` entry the migration does not actually produce is also a failure, so a `checks.json` written for an earlier migration cannot excuse a later, unrelated loss. The failure message lists every unexpected finding, `table.column` per item, in one message. (`expected.deleted` and `expected.updated`, the two more keys [Declare an intended row loss](#declare-an-intended-row-loss) above adds, follow the same rule.)

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
| `Schema shape changed unexpectedly` | a table or column vanished, or a column's declared type changed; name it in `expected.dropped` or `expected.retyped` if intended |
| `Rows lost or changed unexpectedly` | a table lost or rewrote rows; name it in `expected.deleted` or `expected.updated` if intended |
| `did not happen` | an `expected` entry names a drop, a retype, a deletion, or an update the migration did not perform; remove the stale entry |

`node spike/11-backup-lifecycle.ts` measures the `backup()` path the snapshot step no longer uses; run it from a source checkout to see the WAL-row and implicit-row-identity checks it still shares with the current `vacuum into` step. It stops after 20 seconds (ADR 0063, ADR 0121).

The rehearsal CLI has a 30,000ms default time budget, including startup and snapshot creation.
Use `--timeout-ms 120000` when the workload needs a larger finite budget.
A deadline produces exit 1 and `REHEARSAL_TIMEOUT` after the parent removes its snapshots.
Inspect the workload before increasing the budget. The source database remains unchanged.
This deadline applies to the CLI; the in-process `rehearse` function does not cancel the snapshot statement.

The read-only open of the source database waits out a lock another connection holds (a `wrangler dev` D1 file or a Durable Object file, both WAL mode), for up to `min(5000, --timeout-ms - 1000)` ms (ADR 0140). A lock that outlasts the wait fails with `SNAPSHOT_FAILED`, naming the source path and "locked"; retry the command.

## Rehearse against a D1 export

```sh
npx wrangler d1 export <database> --remote --output dump.sql
sqlite3 snapshot.sqlite < dump.sql
npx solarsql rehearse snapshot.sqlite migrations/000N_<name>.sql checks.json
```

Confirm current flags with `npx wrangler d1 export --help`.

Export refuses a database that already has an FTS5 search table:

```
D1 Export error: cannot export databases with Virtual Tables (fts5)
```

Work around this. Drop the search table and its triggers from a copy of the database before exporting, or rehearse without the search table. The generator's own `insert into <search> ... select ...` statement, emitted right after `create virtual table` when the search table's one insert trigger keeps to the documented shape, repopulates it once the migration applies for real (`migrations.md`, "What a migration holds", ADR 0118); the rehearsal itself does not need the search table present.
