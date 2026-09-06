# The schema

The schema of a module is DDL in string literals in `module.ts`: `table()`, `index()`, `view()`, `trigger()`, `search()`, each with one CREATE statement.
The build applies every module's DDL to an in-memory SQLite and reads the types back from the engine.

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

## Rules

- Every table is `strict`, so the engine rejects a value that does not match the declared type, and the generated types hold for every stored value.
- A primary key column is `not null`. The build refuses a table without a primary key.
- The declared types are `text`, `integer`, `real`, `blob`, and `any`. Another type is refused.
- A table name is declared by one module. A second declaration is refused.
- An index is on a table of its module.
- A trigger sits on a table or a view of its module, and its body touches the tables of that module only (an INSTEAD OF trigger sits on a view of the module).
- A view is read by the queries of its module like a table. A view over another module's table needs `readsAll` on the module.
- A search table is `create virtual table ... using fts5(...)`. The module owns it like a table. It has no ALTER: a change drops it and creates it again, and the rows come back through the triggers that fill it.
- The leading `--` lines of a statement are its documentation, and the build keeps them in the generated file.

## Types from the DDL

| Declared | Column type | Note |
|---|---|---|
| `text` | `string` | |
| `integer` | `number` | |
| `real` | `number` | |
| `blob` | `Uint8Array` | |
| `any` | `SqlValue` | `string \| number \| bigint \| null \| Uint8Array` |
| a column without `not null` | `T \| null` | |
| `check (c in ('a', 'b'))` | `"a" \| "b"` | strings or numbers: `check (flag in (0, 1))` is `0 \| 1` |
| the primary key `id` of table `orders` | `OrdersId` | a branded string; `Id<"orders">` |
| a column that references `customers(id)` | `CustomersId` | the brand of the referenced key |
| a generated column | as declared | read like any other; a migration never sets it |
| a column of a search table | `string \| null` | `rank` is `number` |

The brand of a table name is its PascalCase plus `Id`: `order_lines` gives `OrderLinesId`. `newId<OrdersId>()` makes one (UUID v7).

## Search tables

```ts
export const orderSearch = search(`create virtual table order_search using fts5(order_id unindexed, note)`);

export const orderSearchInsert = trigger(`
  create trigger order_search_insert after insert on orders
  begin
    insert into order_search (order_id, note) values (new.id, new.note);
  end
`);

export const orderSearchUpdate = trigger(`
  create trigger order_search_update after update of note on orders
  begin
    delete from order_search where order_id = new.id;
    insert into order_search (order_id, note) values (new.id, new.note);
  end
`);
```

A query joins the hits back to the table: `from order_search join orders o on o.id = order_search.order_id where order_search match :query order by rank`. `bm25(order_search)` is an expression and takes a cast.
The engine keeps five shadow tables next to a search table (`_config`, `_content`, `_data`, `_docsize`, `_idx`); the build and the migration never name them.
No trigger follows a delete into the search table; a command that deletes rows deletes their search rows too.

## Adding a module by hand

Three files and one line: `modules/<name>/module.ts`, `modules/<name>/public.ts`, and the entry in `solarsql.config.ts`. The first `npx solarsql build` writes `solarsql.generated.ts`.

```ts
// public.ts: the id type, the queries, and the commands. Tables stay private.
export type { OrdersId } from "./solarsql.generated.ts";
export { orderQueries, orderCommands } from "./module.ts";
```
