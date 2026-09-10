# Running

The same module code runs on every adapter.

```ts
import { newId, read } from "solarsql";
import { d1 } from "solarsql/d1";
// or: import { durable, migrate } from "solarsql/durable";
// or, in a test or a script: import { migrate, node } from "solarsql/node";

const db = d1(env.DB);

await db.run(orderCommands.place, { id: newId<OrdersId>(), customer_id, lines });

const order = await db.first(orderQueries.byId, { id });
// { id: OrdersId; customer_id: CustomersId; status: "draft" | "confirmed"; note: string | null } | null

const result = await db.run(orderCommands.confirm, { id });
// see commands.md: { ok: true; rows } | { ok: false; kind: "assert" | "unique" | ... }

const [orders, customers] = await db.batch([read(orderQueries.byId, { id }), read(customerQueries.all)]);
// orders: Row<typeof orderQueries.byId>[]; customers: Row<typeof customerQueries.all>[]
```

## Database

| Call | Gives |
|---|---|
| `db.all(query, params)` | `Row<typeof query>[]` |
| `db.first(query, params)` | `Row<typeof query> \| null` |
| `db.run(command, params)` | `CommandResult<typeof command>` |
| `db.batch([read(q1, p1), read(q2)])` | the rows of each, by position; one D1 round trip, one `batch()` |

A query without parameters takes none: `db.all(customerQueries.all)`.
JSON columns arrive parsed, and array parameters go encoded; the module code sees plain values.
Retry, concurrency, and dependency injection stay in the calling code. A function of a module takes `db: Database`.

## What a query and a command carry

`orderQueries.byId.meta.reads` names the tables the statement reads, sorted, once each: the tables and search tables of the schema, reached directly, through a view, through a trigger the statement fires, or by a foreign key check.
A view, `json_each`, and a `pragma_*` function hold no rows and do not appear.
A command carries one such entry per statement of its plan in `meta.statements`, and one for `returns`.
A caller that picks a data source by table, or drops a cache by table, reads it instead of parsing the SQL.

## Adapters

| Adapter | Takes | A command is |
|---|---|---|
| `d1(env.DB, options?)` from `solarsql/d1` | a D1 binding, or a session: `env.DB.withSession("first-primary")` fits the same shape | one `batch()`, one transaction |
| `durable(ctx.storage, options?)` from `solarsql/durable` | a Durable Object's SQLite storage | one `transactionSync` |
| `node(db, options?)` from `solarsql/node` | a `DatabaseSync` of node:sqlite | one `begin ... commit` |

`options.observe` is a hook for a logger or a tracer, called once per call:

```ts
const db = d1(env.DB, { observe: (e) => console.log(e.kind, e.name, e.outcome, `${e.ms.toFixed(1)}ms`, e.meta?.rows_read) });
// e: { kind: "query" | "batch" | "command"; name: string; ms: number; outcome: string; meta?: EngineMeta }
// outcome: "ok", "assert:<name>", a constraint kind, or "error" when thrown
// the name of a batch is the query names joined with "+"
// meta, on D1 only: { rows_read, rows_written, duration, served_by_region?, served_by_primary? }
//   under the names D1 uses; a batch and a command sum the rows and the duration of their statements;
//   absent on a Durable Object, on node:sqlite, and when the call threw
```

D1 bills on `rows_read` and `rows_written`, so a cost tracer reads `e.meta`.

## Ids

`newId<OrdersId>()` makes a UUID v7: the first 48 bits are the millisecond, and ids made in one millisecond stay in order.
`Id<"orders">` is the brand of a table's primary key; the generated file exports it as `OrdersId`, and `public.ts` re-exports it.
A brand is a string at runtime.

## A module's test

A module's own tests run on node:sqlite, in-process, through the migration files, with the same module code that runs in production:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { newId } from "solarsql";
import { migrate, node } from "solarsql/node";
import { migrations } from "../../migrations/index.ts";
import { orderCommands, orderQueries, type OrdersId } from "./public.ts";

test("confirm once", async () => {
  const raw = new DatabaseSync(":memory:");
  migrate(raw, migrations);
  const db = node(raw);
  const id = newId<OrdersId>();
  // ...
});
```

node:sqlite and workerd carry the same SQLite, and the constraint messages are the same text, so a test here tests the SQL that runs on D1. Miniflare stays for the library's own tests of the D1 batch and the Durable Object transaction.
