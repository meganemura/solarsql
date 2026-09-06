# Commands

A command is a verb on the module's noun, and a command is a plan: statements and asserts, in order, with named parameters, that run as one D1 batch or one Durable Object transaction.
It is listed in `commands(generated, { ... })`.

```ts
import { assert, commands } from "solarsql";
import { generated } from "./solarsql.generated.ts";

export const orderCommands = commands(generated, {
  place: {
    plan: [
      "insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')",
      `insert into order_lines (id, order_id, sku, qty, price)
       select value ->> 'id', :id, value ->> 'sku', value ->> 'qty', value ->> 'price' from json_each(:lines)`,
    ],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
  confirm: {
    plan: [
      assert("has_lines", "exists (select 1 from order_lines where order_id = :id)"),
      "update orders set status = 'confirmed' where id = :id and status = 'draft'",
      assert("was_draft", "changes() = 1"),
    ],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
  reprice: {
    plan: [
      `update order_lines
       set price = (select value ->> 'price' from json_each(:lines) where value ->> 'id' = order_lines.id)
       where order_id = :id and id in (select value ->> 'id' from json_each(:lines))`,
      assert("all_lines_known", "changes() = json_array_length(:lines)"),
    ],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
  clear: {
    plan: ["delete from order_lines", "delete from orders", "delete from order_search"],
  },
});
```

## The parts

- `plan`: one or more statements (`insert`, `update`, `delete`, `insert ... on conflict do update`, `insert or ignore`, `replace into`) and asserts, in order.
- `assert(name, predicate)`: any SQL expression that yields 0 or 1, with the parameters of the command: a comparison, `exists (...)`, `not exists (...)` over a join. When it yields 0 the whole plan rolls back, and the result names the assert.
- `changes()` in an assert counts the rows of the statement right before it. The build refuses an assert with `changes()` elsewhere.
- `returns`: optional, one `select` that runs last in the same transaction and gives the rows of the result. Without it, `rows` is empty.
- Parameters are shared across the plan: `:id` is one value with one type. Two statements that give it two types are refused; the message names both.

## The result

`db.run(command, params)` gives `CommandResult<typeof command>`:

```ts
{ ok: true; rows: Row[] }                                    // rows of `returns`, or []
| { ok: false; kind: "assert"; assert: "has_lines" | "was_draft" }
| { ok: false; kind: "unique"; table: string; columns: string[] }
| { ok: false; kind: "check"; constraint: string }
| { ok: false; kind: "not_null"; table: string; column: string }
| { ok: false; kind: "foreign_key" }
| { ok: false; kind: "datatype"; table: string; column: string; stored: string; declared: string }
```

A failed assert and a rejected row are values with one `kind`, and nothing of the plan stays written. Every other engine error is thrown.
`kind: "assert"` carries the union of the plan's assert names, so a `switch` on it is exhaustive.

## What a plan may touch

A plan writes the tables of its module. A write into another module's table is refused by the build, with or without `readsAll`.
So a transaction is a module: tables that change together live in one module.
An assert may read the tables of its module and the primary keys its foreign keys reference; a rule that reads more of another module lives in a module with `readsAll`, which still writes only its own tables.
A delete from a parent table reads the foreign key columns of its children, in any module, and the build allows that read.

## Bulk writes

Many rows come in one array parameter and one statement: `insert ... select ... from json_each(:rows)` for inserts, `update ... where id in (select value ->> 'id' from json_each(:rows))` for updates, and `changes() = json_array_length(:rows)` as the assert that every id was known.
An `insert ... on conflict (id) do update set qty = excluded.qty` types its parameters from the insert columns.
