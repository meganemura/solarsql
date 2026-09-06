# solarsql

A typed SQL layer for SQLite on Cloudflare, for D1 and Durable Objects.
It is written for a coding agent that reads one module at a time, and for the human who reviews the agent's work.

You write SQL. The build step asks the real engine what the SQL returns, and writes the types down.
A command is a list of statements and asserts that runs as one transaction on both targets.
A module owns its tables, and the build step refuses a statement that reaches into another module's tables.

## The shape

```
solarsql.config.ts
modules/
  orders/
    module.ts               the schema (tables, indexes, search tables, views, triggers), the queries, and the commands, as SQL strings
    public.ts               what other modules may import
    solarsql.generated.ts   written by `solarsql build`, committed
migrations/
  0001_initial.sql          written by `solarsql migration <name>`
  index.ts                  the same files, for a Durable Object
```

## Add a command

1. Write the plan in `module.ts`, in `commands(...)`: statements and asserts, with `:name` parameters.
2. Run `npx solarsql build`. It prints a `+` line for each statement it added and a `-` line for each it removed, and rewrites `solarsql.generated.ts`.
3. Export the command through `public.ts` when the Worker or another module calls it.
4. Call `db.run(orderCommands.confirm, { id })` and read the result by its `kind`.
5. Run `tsc` and the tests. A statement whose text changed has no type until the build runs again, and `tsc` names the call site.

### module.ts

One file holds the schema, the queries, and the commands of the module, in that order.
The three parts are shown one at a time below, each with the imports it needs; in the file they share one import line.

#### The schema

```ts
import { index, search, table, trigger, view } from "solarsql";

export const orders = table(`
  -- An order placed by one customer.
  create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text,
    updated_at text
  ) strict
`);

export const orderLinesByOrder = index(`create index order_lines_order_id on order_lines (order_id)`);

export const ordersTouch = trigger(`
  create trigger orders_touch after update on orders
  begin
    update orders set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
  end
`);

export const openOrders = view(`create view open_orders as select id, customer_id from orders where status = 'draft'`);

export const orderSearch = search(`create virtual table order_search using fts5(order_id unindexed, note)`);
```

The leading `--` lines are the documentation of the table.
A primary key column must be `not null`.
A `check (x in (...))` becomes a union type, of strings or of numbers: `check (flag in (0, 1))` is `0 | 1`.
A generated column is read like any other.
Every table is `strict`, so the engine rejects a value that does not match the declared type, and the generated types hold for every stored value.
A trigger sits on a table or a view of its module, and its body may touch the tables of that module only.
A search table is FTS5: its columns are text, `rank` is a number, and `where order_search match :query` takes a string. Two triggers keep it in step with the table it indexes, one after insert and one after update of the column.
A view is read by the queries of its module like a table; a report module with `readsAll` may declare a view over every table.

#### The queries

```ts
import { queries } from "solarsql";
import { generated } from "./solarsql.generated.ts";

export const orderQueries = queries(generated, {
  byId: `
    -- One order, or none.
    select id, customer_id, status, note from orders where id = :id`,
  withLines: `
    -- One order with its lines as an array. Empty when it has none.
    select o.id, o.status,
      coalesce(json_group_array(json_object('id', l.id, 'sku', l.sku, 'qty', l.qty))
        filter (where l.id is not null), '[]') as lines
    from orders o
    left join order_lines l on l.order_id = o.id
    where o.id = :id
    group by o.id`,
});
```

Parameters are named, `:id`.
The build finds their types from where they sit: `where id = :id` gives `:id` the type of the column.
A JSON aggregation becomes an array type, and the adapter parses it.
A one-to-many inside it is `json((select json_group_array(...) from child where child.parent_id = l.id))`; the `json()` makes it nest as JSON, not as a string.
An expression column needs a `cast(... as integer | real | text)`, because the engine reports no type for an expression.
The type of a cast is `T | null`, except over `count`, `total`, `exists`, a ranking window function, or `coalesce` with a literal, which are never null.

Dynamic needs are static SQL with a typed parameter:

```sql
-- a list: pass an array, any length, one bound value
select id from orders where id in (select value from json_each(:ids))
-- many rows: pass an array of objects
insert into order_lines (id, order_id, qty) select value ->> 'id', :order_id, value ->> 'qty' from json_each(:lines)
-- many updates: the same array, and each value ->> 'key' takes the type of the column it meets
update order_lines set qty = (select value ->> 'qty' from json_each(:lines) where value ->> 'id' = order_lines.id)
  where id in (select value ->> 'id' from json_each(:lines))
-- an optional filter: pass null to skip it (the build reports the full scan)
select id from orders where customer_id = :customer_id and (:status is null or status = :status)
-- a sort column and paging
order by case :sort when 'id' then id when 'status' then status end limit :limit offset :offset
```

#### The commands

```ts
import { assert, commands } from "solarsql";
import { generated } from "./solarsql.generated.ts";

export const orderCommands = commands(generated, {
  confirm: {
    plan: [
      assert("has_lines", "exists (select 1 from order_lines where order_id = :id)"),
      "update orders set status = 'confirmed' where id = :id and status = 'draft'",
      assert("was_draft", "changes() = 1"),
    ],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
});
```

A plan runs as one D1 batch or one Durable Object transaction.
An assert is any SQL expression that yields 0 or 1, and it may use the parameters of the command: a comparison, an `exists (...)`, or a `not exists (...)` over a join, such as `not exists (select 1 from order_lines l join inventory i on i.sku = l.sku where l.order_id = :id and i.qty + l.qty > 100)`.
When it yields 0, the whole plan rolls back, and the result names the assert.
`changes()` counts the rows of the statement right before the assert.

### Running

```ts
import { newId } from "solarsql";
import { d1 } from "solarsql/d1";
// or: import { durable } from "solarsql/durable";
// or, in a test or a script: import { node } from "solarsql/node";

const db = d1(env.DB);

// An id is made before the first statement runs: a UUID v7.
await db.run(orderCommands.place, { id: newId<OrdersId>(), customer_id, lines });

const order = await db.first(orderQueries.byId, { id });
// { id: OrdersId; customer_id: CustomersId; status: "draft" | "confirmed"; note: string | null } | null

const result = await db.run(orderCommands.confirm, { id });
// { ok: true; rows: [...] }
// | { ok: false; kind: "assert"; assert: "has_lines" | "was_draft" }
// | { ok: false; kind: "unique"; table: string; columns: string[] }
// | { ok: false; kind: "check" | "not_null" | "foreign_key" | "datatype"; ... }
```

The same module code runs on every adapter.
`db.all` returns every row, `db.first` returns one row or null, and `db.run` runs a command.
`db.batch` runs several queries in one D1 round trip and returns their rows by position:

```ts
import { read } from "solarsql";

const [orders, customers] = await db.batch([read(orderQueries.byId, { id }), read(customerQueries.all)]);
// orders: Row<typeof orderQueries.byId>[]; customers: Row<typeof customerQueries.all>[]
```

A failed assert and a rejected row are values with one `kind`. Every other engine error is thrown.

An adapter takes an `observe` hook for a logger or a tracer:

```ts
const db = d1(env.DB, { observe: (e) => console.log(e.kind, e.name, e.outcome, `${e.ms.toFixed(1)}ms`) });
```

Retry, concurrency, and dependency injection stay in the calling code. A module function takes `db: Database`.

A module's own tests run on node:sqlite, in-process, with the same module code:

```ts
import { DatabaseSync } from "node:sqlite";
import { migrate, node } from "solarsql/node";
import { migrations } from "./migrations/index.ts";

const raw = new DatabaseSync(":memory:");
migrate(raw, migrations);
const db = node(raw);
```

### solarsql.config.ts

```ts
import { config } from "solarsql";

export default config({
  modules: ["./modules/customers", "./modules/orders", { dir: "./modules/reports", readsAll: true }],
  migrations: "./migrations",
});
```

A module with `readsAll` may read every table. It is for reports.

## The build

```
npx solarsql build
```

The build imports every module, applies the schema to an in-memory SQLite, prepares every statement, and writes `solarsql.generated.ts` next to each module.
It fails with one message when:

- a statement does not prepare (the engine's own message);
- an expression column has no `cast`;
- a `json_group_array` over an outer join has no `filter`;
- a parameter has two different types in one command;
- a statement, a view, or a trigger body touches a table that another module owns;
- a file of a module imports a file of another module that is not its `public.ts`;
- a primary key allows NULL;
- a table is not `strict`;
- the migration files do not match the schema.

The generated types are keyed by the SQL text.
A query whose text changed has no entry, so `tsc` fails at the call site until the build runs again.

```
npx solarsql build --check
```

The same checks, with nothing written: the command exits 1 when a generated file or a migration is behind the source. It is for CI and for a test hook.

## Migrations

```
npx solarsql migration <name>
```

This writes `migrations/NNNN_<name>.sql` with the difference between the migration files and the schema, in the format wrangler applies.
A table rebuild, for a constraint change, runs inside one transaction and keeps the rows and the foreign keys.
A changed view or trigger is dropped and created again; a rebuild drops every view first, because a rename under a view fails.
A changed search table is dropped and created again, and starts empty: the table it indexes keeps its rows, and the search rows must be inserted again.
The generator stops and asks when a table both loses and gains a column, or when a new column is `not null` without a default.

On D1, wrangler applies the files.
On a Durable Object, the constructor applies them:

```ts
import { migrate } from "solarsql/durable";
import { migrations } from "./migrations/index.ts";

ctx.blockConcurrencyWhile(async () => {
  migrate(ctx.storage, migrations);
});
```

## Deploy the example

The example is a Worker with a D1 binding and a Durable Object, and wrangler deploys it.
Copy the template, create the database, and put the id it prints in the copy:

```sh
cd example
cp wrangler.example.jsonc wrangler.jsonc   # gitignored: it names your database
npx wrangler d1 create solarsql-example    # prints the id for wrangler.jsonc
npx wrangler d1 migrations apply solarsql-example --remote
npx wrangler secret put TOKEN              # any string; the Worker refuses a request without it
npx wrangler deploy
```

`wrangler d1 migrations apply` takes the files of `example/migrations` in name order and keeps its own record of the applied ones.
The Durable Object applies the same files with `migrate()` on its first request.

The remote test sends the steps of the Miniflare test to the deployed Worker, on D1 and on the Durable Object, after a reset of both:

```sh
SOLARSQL_REMOTE_URL=https://solarsql-example.<your subdomain>.workers.dev SOLARSQL_REMOTE_TOKEN=<the secret> node --test test/remote.test.ts
```

`npm test` skips it.

## Requirements

Node 24.10 or later runs the build, because it needs `DatabaseSync.setAuthorizer()` of node:sqlite. The tests of this repository run on Node 26.

## Design

The design decisions are in [docs/](docs/README.md), one ADR each, with the measurements they rest on.
The example project in [example/](example/) is the one the tests run on D1 and on a Durable Object.

## License

MIT
