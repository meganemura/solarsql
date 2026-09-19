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
// see commands.md: { ok: true; rows; changes } | { ok: false; kind: "assert" | "unique" | ... }

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
Each call requires exactly its generated own parameter keys before SQL runs.
An inherited value reports a missing parameter, and an extra enumerable key reports an unexpected parameter. The message names the query or command that rejected the call, and what it declares (ADR 0088).
A command validates the union of its plan, asserts, and `returns`; each statement then binds its own ordered subset.
JSON columns arrive parsed, and array parameters go encoded; the module code sees plain values.
Retry, concurrency, and dependency injection stay in the calling code. A function of a module takes `db: Database`.

## Types outside the module

A loader, a CLI, or any code outside the module takes its row type from the query and its parameter type from the command, so a field is written once, in the SQL.

```ts
import type { Params, Row } from "solarsql";
import { orderCommands, orderQueries } from "./modules/orders/public.ts";

type Order = Row<typeof orderQueries.byId>;                      // { id: OrdersId; customer_id: CustomersId; status: "draft" | "confirmed"; note: string | null }
type Line = Params<typeof orderCommands.place>["lines"][number]; // { id: OrderLinesId; sku: string; qty: number; price: number }
```

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
| `node(db, options?)` from `solarsql/node` | a `DatabaseSync` of node:sqlite | one savepoint; an enclosing transaction remains owned by its caller |

A caller that keeps its own reference to a session made with `withSession(...)` can call `.getBookmark()` on that reference directly, after passing the same object into `d1()` -- `d1()` never takes ownership of it. That bookmark is how a caller builds read-your-writes consistency across two requests: read it after the first request's call, and pass it into the next request's own `withSession(bookmark)`. solarsql does not wrap `getBookmark()` on `D1Like` or `Database`, since the caller already holds what it needs.

A caller can also reach past the generated queries and commands and run raw SQL directly against the underlying binding, one line per target:

- D1: `const rows = (await env.DB.prepare(sql).all()).results;` -- D1's `.all()` resolves to `{ success, meta, results }`, not a plain array; take `.results` for the rows. Cloudflare also ships a CLI that runs a raw statement with no application code at all: `npx wrangler d1 execute <database> --command "..."`.
- Durable Object: `const rows = ctx.storage.sql.exec(sql).toArray();` -- `.exec()` returns a cursor, so `.toArray()` reads it into a plain array (`src/durable.ts` uses this same pattern throughout). A Durable Object has no REPL and no external client, so run this line temporarily inside code where `ctx.storage` is already in scope -- typically the constructor's `blockConcurrencyWhile` block -- log the rows, then delete the line once you have confirmed what you needed.
- Node: `const rows = raw.prepare(sql).all();` -- `raw`, the underlying `node:sqlite` `DatabaseSync` a test or script constructs and passes to `node()`, returns rows as a plain array too.

The same `ctx.storage` reference also exposes `sql.databaseSize` (the current database size in bytes) directly, reachable the same way as the raw SQL line above. solarsql does not surface `databaseSize` through `observe()`, because it is a whole-database snapshot rather than a per-statement value.

`ctx.storage` also exposes three Point-In-Time Recovery methods -- `getCurrentBookmark()`, `getBookmarkForTime(timestamp)`, and `onNextSessionRestoreBookmark(bookmark)` -- directly, reachable the same way. solarsql does not wrap them, because they act on the whole storage rather than on a typed query or command.

`options.observe` is a hook for a logger or a tracer, called once per call:

```ts
const db = d1(env.DB, { observe: (e) => console.log(e.kind, e.name, e.outcome, `${e.ms.toFixed(1)}ms`, e.meta?.rows_read) });
// e: { kind: "query" | "batch" | "command"; name: string; ms: number; outcome: string; meta?: EngineMeta }
// outcome: "ok", "assert:<name>", a constraint kind, or "error" when thrown
// the name of a batch is the query names joined with "+"
// meta, on D1 and on a Durable Object: { rows_read, rows_written, duration?, served_by_region?, served_by_primary? }
//   under the names D1 uses; a batch and a command sum the rows (and D1's duration) of their statements;
//   duration is D1 only (a Durable Object has no server-side timing to report);
//   meta itself is absent on node:sqlite, and when the call threw
```

Observation is best-effort and cannot change the database result.
The adapter contains synchronous throws and rejected observer promises, and does not await telemetry completion.
An observer that needs failure reporting must handle and report its own delivery errors.

Both D1 and a Durable Object bill on `rows_read` and `rows_written`, so a cost tracer reads `e.meta` on either engine.

## Ids

`newId<OrdersId>()` makes a UUID v7: the first 48 bits are the millisecond, and ids made in one millisecond stay in order.
`Id<"orders">` brands a table's single TEXT primary key; the generated file exports it as `OrdersId`, and `public.ts` re-exports it.
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

Node tests check SQL locally. Miniflare tests check the D1 batch and Durable Object transaction contracts.
Engine versions and adapter conversions must be checked for each target.

## Values across adapters

BLOB results use `Uint8Array` on all adapters, including BLOB values in an ANY column.
The adapters convert D1 byte arrays and Durable Object ArrayBuffers before decoding JSON text.
JSON arrays remain ordinary arrays. SQL NULL remains `null`.
INTEGER results use JavaScript numbers. Keep portable integer values within the safe integer range.
Node rejects reads outside that range; D1 can lose precision and its API does not support bigint parameters.
`SqlValue` describes possible SQLite values, not a promise that each adapter accepts every value.
An engine error is thrown; the adapters do not retry an operation whose commit outcome is unknown.
Use an application idempotency key or reconciliation before repeating a write after a lost response.
`failureClass(error)` (ADR 0120) reads that thrown value and sorts it, so a caller does not read Cloudflare's error text by hand:

| Message or prefix | Platform | Class | Outcome | What the caller does | Source |
| --- | --- | --- | --- | --- | --- |
| `Durable Object is overloaded.` | Durable Object | transient | not_applied | The request never ran; reduce load or send fewer requests (the page says this, not "retry"). | [DO troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/), 2026-05-15 |
| `Your account is generating too much load on Durable Objects...` | Durable Object | transient | not_applied | Retry, after a short wait; lookups are cached. | [DO troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/), 2026-05-15 |
| `Your account is doing too many concurrent storage operations...` | Durable Object | transient | not_applied | Back off; prefer one batched read over several single ones. | [DO troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/), 2026-05-15 |
| `D1 DB is overloaded.` | D1 | transient | not_applied | The request never ran; the page's own action is to send fewer or cheaper requests, not "retry". | [D1 debug](https://developers.cloudflare.com/d1/observability/debug-d1/), 2026-08-11 |
| `Cannot resolve D1 DB due to transient issue on remote node.` | D1 | transient | not_applied | Retry. | [D1 debug](https://developers.cloudflare.com/d1/observability/debug-d1/), 2026-08-11 |
| `Network connection lost.` | D1, Workers | transient | unknown | Reconcile before repeating a write. | [D1 debug](https://developers.cloudflare.com/d1/observability/debug-d1/), 2026-08-11; [Workers errors](https://developers.cloudflare.com/workers/observability/errors/), 2026-09-19 |
| `Replica disconnected from primary.` | D1 | transient | unknown | Reconcile before repeating a write. | [D1 debug](https://developers.cloudflare.com/d1/observability/debug-d1/), 2026-08-11 |
| `... reset because its code was updated.` | D1, Durable Object | transient | unknown | Reconcile before repeating a write. | [D1 debug](https://developers.cloudflare.com/d1/observability/debug-d1/), 2026-08-11; [DO troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/), 2026-05-15 |
| `... storage operation exceeded timeout which caused object to be reset.` | D1, Durable Object | transient | unknown | Reconcile before repeating a write. | [D1 debug](https://developers.cloudflare.com/d1/observability/debug-d1/), 2026-08-11; [DO troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/), 2026-05-15 |
| `Internal error ... caused object to be reset.` | D1 | transient | unknown | Reconcile before repeating a write. | [D1 debug](https://developers.cloudflare.com/d1/observability/debug-d1/), 2026-08-11 |
| A reset-and-rolled-back wrapper, resolved or not | Durable Object | permanent | (fixed) | Fix the data or the schema; nothing was applied. The wrapper's own text names both the cause (a constraint) and the rollback. | `src/runtime/plan.ts`'s `bareMessage()` comment, checked 2026-09-19 (not on the five fetched pages) |
| `SQLITE_BUSY`, `SQLITE_LOCKED`, "database is locked" | Node, D1, Durable Object | transient | not_applied | Retry; another connection held the lock this statement needed. | [SQLite result codes](https://sqlite.org/rescode.html), checked 2026-09-19 |
| `D1_EXEC_ERROR`, `near "..."`, `D1_TYPE_ERROR`, `D1_COLUMN_NOTFOUND`, `no such table`, `no such column`, a `SQLITE_` code, an unresolved constraint | D1, Durable Object, Node | permanent | (fixed) | Fix the query or the schema; do not retry. | [D1 debug](https://developers.cloudflare.com/d1/observability/debug-d1/), 2026-08-11 (only `D1_EXEC_ERROR`, `near "..."`, `D1_TYPE_ERROR`, and `D1_COLUMN_NOTFOUND` are on this page; the rest come from the engine's own text, per `src/runtime/plan.ts`) |

```ts
const f = failureClass(e);
if (f.kind === "transient" && f.outcome === "not_applied") {
  retry();
} else if (f.kind === "transient") {
  reconcile();
} else throw e;
```

The local tests exercise Node, D1 and Durable Object scalar representations.
Remote behavior is checked by the opt-in remote suite; local tests do not certify a deployed database.
See [D1 value conversion](https://developers.cloudflare.com/d1/worker-api/#type-conversion).

The Node adapter uses savepoints, so direct SQL and typed commands can share a caller-owned transaction.
An ordinary command failure rolls back its work. The caller still owns the outer COMMIT or ROLLBACK.
Deferred constraints can fail at that outer commit after an inner command returned success.
`migrate()` uses the same savepoints, so a deferred constraint that a migration adds also fails at the outer commit.
SQLite transaction-ending conflicts such as `INSERT OR ROLLBACK` can roll back the outer transaction.
Failed savepoint cleanup throws an `AggregateError`; inspect its original cause and do not continue as if the outer transaction survived.
This behavior applies to Node; D1 uses its batch API (ADR 0072).
