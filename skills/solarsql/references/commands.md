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

- `plan`: SQL statements (`select`, `values`, `insert`, `update`, `delete`, `replace`, including WITH forms) and asserts, in order. Each SQL item contains one statement.
- `assert(name, predicate)`: any SQL expression, with the parameters of the command: a comparison, `exists (...)`, `not exists (...)` over a join. SQLite's own truthiness decides pass or fail, the same as inside a `WHERE` clause: NULL, and text or a blob SQLite cannot read as a nonzero number, count as false. When the predicate is false the whole plan rolls back, and the result names the assert.
- `changes()` in an assert counts the rows of the statement right before it. The build refuses an assert with `changes()` elsewhere, and refuses `changes()` inside `returns` too, since `returns` runs after the plan's last statement.
- `returns`: optional, one `select` or `values` statement that runs last in the same transaction and gives the rows of the result. Without it, `rows` is empty.
- The build refuses writes in `returns`, multiple statements per item, transaction control, PRAGMA, and schema changes. The adapter owns the transaction.
- Parameters are shared across the plan: `:id` is one value with one type. Two statements that give it two types are refused; the message names both.

## The result

`db.run(command, params)` gives `CommandResult<typeof command>`:

```ts
{ ok: true; rows: Row[]; changes: number }                   // rows of `returns`, or [], and rows changed
| { ok: false; kind: "assert"; assert: "has_lines" | "was_draft" }
| { ok: false; kind: "unique"; table: string; columns: string[] }
| { ok: false; kind: "unique_index"; index: string }
| { ok: false; kind: "check"; constraint: string }
| { ok: false; kind: "not_null"; table: string; column: string }
| { ok: false; kind: "foreign_key" }
| { ok: false; kind: "datatype"; table: string; column: string; stored: string; declared: string }
```

An expression-index UNIQUE failure reports `unique_index` and the decoded index name.
A table-column UNIQUE failure reports `unique` with its table and columns.
SQLite error text cannot separate table and column names that contain dots; the adapter preserves that engine error instead of reporting an incorrect target.

A failed assert and a rejected row are values with one `kind`, and nothing of the plan stays written. Every other engine error is thrown.
The adapter gives each command invocation a private guard identity, so a user trigger that raises the same public name remains an engine error.
A command whose plan has an assert deletes every guard-table row once the plan and its returns clause finish reading.
The table holds no rows between commands.
`kind: "assert"` carries the union of the plan's assert names, so a `switch` on it is exhaustive.
`changes` counts the rows the plan's statements inserted, updated, or deleted, the rows their triggers wrote included, as D1's `meta.changes` counts them, where an assert's `changes()` leaves a trigger's rows out; an assert and `returns` add nothing, and a plan that changed nothing gives 0.

## What a plan may touch

A plan writes the tables of its module. A write into another module's table is refused by the build, with or without `readsAll`, naming the owner's `module.ts` and its commands catalog: `inserts into <table>. Module <owner> owns <table> in modules/<owner>/module.ts; write it through a command of <owner>'s commands catalog.`
So a transaction is a module: tables that change together live in one module.
An assert may read the tables of its module and the primary keys its foreign keys reference; a rule that reads more of another module lives in a module with `readsAll`, which still writes only its own tables.
A delete from a parent table reads the foreign key columns of its children, in any module, and the build allows that read.

## Include another module's command

A write that spans two modules includes the owner's command in the plan, imported from its `public.ts` (ADR 0127):

```ts
// modules/customers/module.ts
import { orderCommands } from "../orders/public.ts";

export const customerCommands = commands(generated, {
  remove: {
    plan: [orderCommands.deleteByCustomer, "delete from customers where id = :customer_id"],
  },
});
```

The build expands the included command in place, into its own statements and asserts, so the plan still runs as one D1 batch or one Durable Object transaction.

- Each expanded statement keeps its owning module: the ownership check above applies to it under that module, not under the including module.
- Parameters merge by name, the plan's existing rule: give the shared value the same name in the including statement and in the included command, so the caller gives it once, not once per name.
- Assert names must be unique across the whole expanded plan; a name the including command and the included command both use is refused, naming both.
- The included command's `returns` is dropped; only the including command's `returns` runs.
- `changes()` in an assert still counts the statement right before it, in the expanded order.
- The included module must be listed before the including module in `modules`: it is already the rule a public import across modules needs.
- `inspect` and `--json` show each expanded item's source module and command (`source: { module, command }`), `null` for the including module's own items.

| The message contains | Fix |
|---|---|
| `must come before module <including> in modules` | list the included command's module earlier in `modules` |
| `whose statements no module owns` | the included command's statements do not all belong to one module; include the command as it is exported from its own module's `public.ts`, not a re-declared copy |
| `whose statements more than one module owns` | two modules declare the same statement text; give one of them a distinct statement |
| `assert name ... is used twice` | rename one of the two asserts so each name is unique across the expanded plan |

The included command's parameters are values the caller supplies; nothing ties them to the including module's row.
The including plan's asserts own that pairing.
In the example above, an assert before the include pins `:customer_id` to a customer that exists:

```ts
export const customerCommands = commands(generated, {
  remove: {
    plan: [
      assert("customer_exists", "exists (select 1 from customers where id = :customer_id)"),
      orderCommands.deleteByCustomer,
      "delete from customers where id = :customer_id",
    ],
  },
});
```

The general form: `exists (select 1 from <including table> where id = :id and <column> = :<included param>)`.
The build prints one line for each included-command parameter that no statement or assert of the including module names: `note: parameter :x of the included command <name> is not named by any statement or assert of module <m>`. The line is a report, not a refusal.

### Parameter types stay with their owner

The generated declaration of an included command stays stable in its owner module.
The build writes that declaration before it checks modules that include the command, so a later plan cannot rewrite an owner parameter from `SqlValue` to a narrower type.
The owner command remains usable by itself with the type its own SQL establishes.

An including command still combines the included parameter with its own statements and asserts.
If one of those uses gives the shared name a narrower type, the including command requires that narrower type.

If the owner command must require the narrower type when called directly, make a typed use in the owner's SQL, such as a comparison to its table column.
If only an including command needs the narrower type, keep the owner parameter broad and add the type-bearing use in that including plan.
When one statement must serve commands that need incompatible types, give the statement a type of its own or split it into separate statements.

## Bulk writes

Many rows come in one array parameter and one statement: `insert ... select ... from json_each(:rows)` for inserts, `update ... where id in (select value ->> 'id' from json_each(:rows))` for updates, and `changes() = json_array_length(:rows)` as the assert that every id was known.
An `insert ... on conflict (id) do update set qty = excluded.qty` types its parameters from the insert columns.
