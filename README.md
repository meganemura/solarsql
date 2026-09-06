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
    schema.ts               CREATE TABLE, INDEX, VIEW, and TRIGGER, as strings
    queries.ts              named SQL that returns rows
    commands.ts             verbs: a plan of statements and asserts
    public.ts               what other modules may import
    solarsql.generated.ts   written by `solarsql build`, committed
migrations/
  0001_initial.sql          written by `solarsql migration <name>`
  index.ts                  the same files, for a Durable Object
```

## Add a command

1. Write the plan in `commands.ts`: statements and asserts, with `:name` parameters.
2. Run `npx solarsql build`. It prints a `+` line for each statement it added and a `-` line for each it removed, and rewrites `solarsql.generated.ts`.
3. Export the command through `public.ts` when the Worker or another module calls it.
4. Call `db.run(orderCommands.confirm, { id })` and read the result by its `kind`.
5. Run `tsc` and the tests. A statement whose text changed has no type until the build runs again, and `tsc` names the call site.

### schema.ts

```ts
import { index, table, trigger, view } from "solarsql";

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
```

The leading `--` lines are the documentation of the table.
A primary key column must be `not null`.
A `check (x in (...))` becomes a union type, of strings or of numbers: `check (flag in (0, 1))` is `0 | 1`.
A generated column is read like any other.
Every table is `strict`, so the engine rejects a value that does not match the declared type, and the generated types hold for every stored value.
A trigger sits on a table of its module, and its body may touch the tables of that module only.
A view is read by the queries of its module like a table; a report module with `readsAll` may declare a view over every table.

### queries.ts

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

### commands.ts

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
import { d1 } from "solarsql/d1";
// or: import { durable } from "solarsql/durable";

const db = d1(env.DB);

const order = await db.first(orderQueries.byId, { id });
// { id: OrdersId; customer_id: CustomersId; status: "draft" | "confirmed"; note: string | null } | null

const result = await db.run(orderCommands.confirm, { id });
// { ok: true; rows: [...] }
// | { ok: false; kind: "assert"; assert: "has_lines" | "was_draft" }
// | { ok: false; kind: "unique"; table: string; columns: string[] }
// | { ok: false; kind: "check" | "not_null" | "foreign_key" | "datatype"; ... }
```

The same module code runs on both adapters.
`db.all` returns every row, `db.first` returns one row or null, and `db.run` runs a command.
A failed assert and a rejected row are values with one `kind`. Every other engine error is thrown.

An adapter takes an `observe` hook for a logger or a tracer:

```ts
const db = d1(env.DB, { observe: (e) => console.log(e.kind, e.name, e.outcome, `${e.ms.toFixed(1)}ms`) });
```

Retry, concurrency, and dependency injection stay in the calling code. A module function takes `db: Database`.

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
- a primary key allows NULL;
- a table is not `strict`;
- the migration files do not match the schema.

The generated types are keyed by the SQL text.
A query whose text changed has no entry, so `tsc` fails at the call site until the build runs again.

## Migrations

```
npx solarsql migration <name>
```

This writes `migrations/NNNN_<name>.sql` with the difference between the migration files and the schema, in the format wrangler applies.
A table rebuild, for a constraint change, runs inside one transaction and keeps the rows and the foreign keys.
A changed view or trigger is dropped and created again; a rebuild drops every view first, because a rename under a view fails.
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

## Requirements

Node 24.10 or later runs the build, because it needs `DatabaseSync.setAuthorizer()` of node:sqlite. The tests of this repository run on Node 26.

## Design

The design decisions are in [docs/](docs/README.md), one ADR each, with the measurements they rest on.
The example project in [example/](example/) is the one the tests run on D1 and on a Durable Object.

## License

MIT
