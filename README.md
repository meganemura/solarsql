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
    schema.ts               CREATE TABLE and CREATE INDEX, as strings
    queries.ts              named SQL that returns rows
    commands.ts             verbs: a plan of statements and asserts
    public.ts               what other modules may import
    solarsql.generated.ts   written by `solarsql build`, committed
migrations/
  0001_initial.sql          written by `solarsql migration <name>`
  index.ts                  the same files, for a Durable Object
```

### schema.ts

```ts
import { index, table } from "solarsql";

export const orders = table(`
  -- An order placed by one customer.
  create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text
  )
`);

export const orderLinesByOrder = index(`create index order_lines_order_id on order_lines (order_id)`);
```

The leading `--` lines are the documentation of the table.
A primary key column must be `not null`.
A `check (x in (...))` becomes a union type.

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
An assert is SQL that yields 0 or 1.
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
// { ok: true; rows: [...] } | { ok: false; assert: "has_lines" | "was_draft" }
```

The same module code runs on both adapters.
`db.all` returns every row, `db.first` returns one row or null, and `db.run` runs a command.

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
- a statement touches a table that another module owns;
- a primary key allows NULL;
- the migration files do not match the schema.

The generated types are keyed by the SQL text.
A query whose text changed has no entry, so `tsc` fails at the call site until the build runs again.

## Migrations

```
npx solarsql migration <name>
```

This writes `migrations/NNNN_<name>.sql` with the difference between the migration files and the schema, in the format wrangler applies.
A table rebuild, for a constraint change, runs inside one transaction and keeps the rows and the foreign keys.
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

Node 24.10 or later runs the build: `StatementSync.columns()` arrived in Node 23.11 and `DatabaseSync.setAuthorizer()` in Node 24.10.
The tests of this repository run on Node 26.

## Design

The design decisions are in [docs/](docs/README.md), one ADR each, with the measurements they rest on.
The example project in [example/](example/) is the one the tests run on D1 and on a Durable Object.

## License

MIT
