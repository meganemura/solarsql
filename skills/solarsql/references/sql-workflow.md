# A SQL change from adoption to rehearsal

This walkthrough uses a disposable local database.
It shows query growth and repair without translating the query into another API.
The repository test `node --test test/sql-workflow.test.ts` checks this sequence, generated caller types, and actual query results.

## Start with a schema and a query

Save this DDL as `schema.sql`:

```sql
create table accounts(name text not null) strict;
create table invoices(account text not null, amount integer not null) strict;
```

These tables deliberately have no primary keys.
Save `queries.json`:

```json
{"report":"select name from accounts order by name"}
```

Run the [schema analysis command](analyze.md):

```sh
npx solarsql analyze schema.sql queries.json --out solarsql.generated.ts
```

The generated catalog works with `queries(generated, statements)`.
The result initially contains `{ name: string }`.

## Grow the SQL report

Change the `report` string to this SQL, encoded as a JSON string:

```sql
with totals as (
  select account, cast(sum(amount) as integer) as total
  from invoices group by account
)
select a.name, t.total
from accounts a left join totals t on t.account = a.name
order by a.name
```

`sum(amount)` uses the [expression cast rule](queries.md#the-type-of-a-column).
The outer join retains accounts with no invoices.
After generation, the caller sees `{ name: string; total: number | null }`.
The adapter executes the original SQL string.
You can prepare that same string with the direct SQLite driver while investigating a result.

If you write `sum(missing)`, `analyze` exits 1 and reports `queries.report`, the SQL, and the engine error.
Fix the column, then run:

```sh
npx solarsql analyze schema.sql queries.json --out solarsql.generated.ts --check
npx solarsql analyze schema.sql queries.json --out solarsql.generated.ts
npx solarsql analyze schema.sql queries.json --out solarsql.generated.ts --check
npx tsc --noEmit
```

The first check reports `GENERATED_STALE` while preserving the existing output.
Generation repairs the output; the next check verifies it.
Keep this check in CI: a changed JSON input does not itself cause a TypeScript compilation error.
The JSON report also names both tables in `reads` and provides engine origins separately from inferred types.

## Rehearse with stored rows

For this disposable example, create `app.sqlite` with the same schema and these rows using your SQLite driver:

```sql
insert into accounts values ('A'), ('B');
insert into invoices values ('A', 5), ('A', 7);
```

The report returns `A` with `12` and `B` with `null`.
Save `change.sql`:

```sql
alter table invoices add column note text;
```

Save `checks.json`:

```json
{
  "queries": {
    "initial": "select name from accounts order by name",
    "report": "with totals as (select account, cast(sum(amount) as integer) as total from invoices group by account) select a.name, t.total from accounts a left join totals t on t.account = a.name order by a.name"
  },
  "assertions": {
    "accounts": "select count(*) = 2 from accounts",
    "amounts": "select sum(amount) = 12 from invoices"
  }
}
```

```sh
npx solarsql rehearse app.sqlite change.sql checks.json
```

The report lists row counts before and after, checked query names, and passed assertion names.
Rehearsal checks a disposable backup and leaves the source database unchanged.
A misspelled field such as `assertion` fails with `CHECKS_INVALID`.
Choose assertions that express your data invariants; unchanged row counts alone cannot prove preserved meaning.

Apply a reviewed migration through your existing migration process.
Update `schema.sql` to describe that transition, regenerate, and check again.
For module projects, use the [migration workflow](migrations.md) and [operation inspection](build.md#inspect-an-operation-contract).

## What this evidence establishes

The regression test compiles the generated caller, compares adapter results with direct SQLite results, and checks them again after applying the transition.
It also verifies source bytes remain unchanged during rehearsal.
Rehearsal checks query column names and declared types; it does not prove complete behavioral compatibility or future data invariants.
The test uses local Node SQLite.
Local Miniflare tests cover D1 and Durable Object adapter contracts separately; remote verification remains opt-in.
Use the target checks in [running](running.md) and [deploy](deploy.md) before relying on target-specific behavior.
