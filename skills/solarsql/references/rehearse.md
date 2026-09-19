# Rehearse a migration with existing data

Rehearse a proposed migration before you deploy it, whenever a target database already has rows.
It proves the migration applies to a snapshot of that data without losing rows, breaking a query's shape, or failing an assertion; it does not prove a remote D1 database or a Durable Object accepts the same SQL.

```sh
npx solarsql rehearse local.sqlite proposed.sql checks.json
```

The command opens the source read-only and uses SQLite backup to create a disposable snapshot, including committed WAL data.
It applies the proposed SQL to the snapshot in one transaction and checks database integrity and foreign keys.
It blocks database attachments. It deletes the snapshot on completion or failure.
The versioned JSON result includes before/after row counts, before/after column lists, completed checks, and failure diagnostics. Exit 1 indicates failure.

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

A dropped table names only `table`. A dropped column, or a retyped column, names both `table` and `column`. An `expected` entry the migration does not actually produce is also a failure, so a `checks.json` written for an earlier migration cannot excuse a later, unrelated loss. The failure message lists every unexpected finding, `table.column` per item, in one message.

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
| `did not happen` | an `expected` entry names a drop or a retype the migration did not perform; remove the stale entry |

For a slow local snapshot, run `node spike/11-backup-lifecycle.ts` from a source checkout.
It measures each backup phase, checks WAL rows and implicit row identities, and stops after 20 seconds (ADR 0063).

The rehearsal CLI has a 30,000ms default time budget, including startup and snapshot creation.
Use `--timeout-ms 120000` when the workload needs a larger finite budget.
A deadline produces exit 1 and `REHEARSAL_TIMEOUT` after the parent removes its snapshots.
Inspect the workload before increasing the budget. The source database remains unchanged.
This deadline applies to the CLI; the in-process `rehearse` function does not cancel native backup.
