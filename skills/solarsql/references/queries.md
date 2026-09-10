# Queries

A query is SQL in a string literal with `:name` parameters, listed in `queries(generated, { ... })`.
The build prepares it on the real engine and writes the types of its parameters and its row into `solarsql.generated.ts`, keyed by the SQL text.

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

`Row<typeof orderQueries.byId>` and `Params<typeof orderQueries.byId>` name the types. A parameter is named; `?` is refused.

## The type of a parameter

The build finds the type from where the parameter sits. One parameter may sit in several places; they must agree on the base type, and the parameter allows `null` when every column it meets allows it.

| Where `:p` sits | Type |
|---|---|
| `where c = :p`, `c < :p`, `:p = c`, `c like :p`, `t match :p` | the type of the column `c` |
| `insert into t (c) values (:p)` | the type of `t.c` |
| `update t set c = :p` | the type of `t.c` |
| `limit :p`, `offset :p` | `number` |
| `:p is null`, `:p is not null` (with another site) | adds `\| null` |
| `case :p when 'a' then ... when 'b' then ... end` | `"a" \| "b"` |
| `:p = 'a'`, `'a' = :p`, `:p in ('a', 'b')` | `"a"`, or the union of the literals |
| `:p = 1` | `number` |
| `c in (select value from json_each(:p))` | `readonly T[]`, `T` the type of `c` |
| `from json_each(:p)` with `value ->> 'k'` used against columns | `readonly { k: T; ... }[]`, each key typed by the column it meets |
| `from json_each(:p)` with `value` used against a column | `readonly T[]` |
| anywhere else | `SqlValue` |

An array parameter is encoded as JSON by the adapter; the SQL sees text and reads it with `json_each`.
A parameter compared with a column of a view is `SqlValue`; compare with the table's column when the type matters.

## The type of a column

A column of the select list that is not a column reference (a column of a table or a view, or `t.*`) is an expression, and an expression needs `cast(... as integer | real | text)`, whatever SQLite would return for it. The one exception is a JSON shape: `json_group_array(...)`, `json_object(...)`, and `coalesce(json_group_array(...) ..., '[]')` need no cast, and the rows below say how the build types them.

| Column of the select list | Type |
|---|---|
| a column of a table, or `t.*` | the declared type ([schema.md](schema.md)); `\| null` on the outer side of a `left join` |
| a column of a view | the type of the column the view selects |
| an expression: `count(*)`, `sum(x)`, `a + b`, `bm25(t)`, a window function, a `case`, a subquery | needs `cast(... as integer \| real \| text)`; the build refuses it without one |
| `cast(expr as T)` | `T \| null` |
| `cast(<shape> as T)` where the whole `<shape>` is `count(...)`, `total(...)`, `row_number()`, `rank()`, `dense_rank()`, `ntile(...)`, `exists (...)`, `not exists (...)`, `coalesce(x, <literal>)`, or `coalesce(x, <not null column>)`, such as `cast(coalesce(b.n, 0) as integer)` | `T`, never null |
| `json_group_array(json_object('k', c, ...))` | `{ k: T; ... }[]`, parsed by the adapter |
| `json_group_array(c)` | `T[]` |
| `json_object('k', c, ...)` | `{ k: T; ... }` |
| `json((select json_group_array(...) from child where child.parent_id = o.id))` inside a `json_object` | a nested array; without the `json()` the column holds JSON text |
| the branches of a `union` | the first branch's types |

A `json_group_array` over the outer side of a `left join` needs `filter (where l.id is not null)`, or a parent with no children gets one null element. `coalesce(..., '[]')` gives the empty array.

## Recipes: dynamic needs as static SQL

```sql
-- a list of any length, one bound value (D1 allows 100 bound values per statement)
select id from orders where id in (select value from json_each(:ids))

-- many rows in one statement
insert into order_lines (id, order_id, qty)
select value ->> 'id', :order_id, value ->> 'qty' from json_each(:lines)

-- many updates from one array; each value ->> 'key' takes the type of the column it meets
update order_lines
set qty = (select value ->> 'qty' from json_each(:lines) where value ->> 'id' = order_lines.id)
where id in (select value ->> 'id' from json_each(:lines))

-- an optional filter: pass null to skip it (the build reports the full scan)
select id from orders where customer_id = :customer_id and (:status is null or status = :status)

-- a sort column chosen by a parameter, typed "id" | "status"
select id, status from orders order by case :sort when 'id' then id when 'status' then status end

-- a sort direction chosen by a parameter, typed "asc" | "desc"
select id from orders order by case :dir when 'asc' then id end asc, case :dir when 'desc' then id end desc

-- paging
select id from orders order by id limit :limit offset :offset

-- a pattern; no index serves LIKE, and the build reports the scan
select id, note from orders where note like :pattern

-- full-text search, best match first, with a typed score
select o.id, o.note, cast(bm25(order_search) as real) as score
from order_search join orders o on o.id = order_search.order_id
where order_search match :query order by rank

-- a one-to-many inside a one-to-many
select c.id,
  json_group_array(json_object('id', o.id,
    'lines', json((select json_group_array(json_object('sku', l.sku)) from order_lines l where l.order_id = o.id))))
  filter (where o.id is not null) as orders
from customers c left join orders o on o.customer_id = c.id
where c.id = :id group by c.id
```

Fragments and string composition are not part of solarsql: a query is one static text, and the types follow the text.

## What the build reports

`scan <module>: <tables> read in full by: <sql>` names a statement with a WHERE clause that the engine still scans in full. The build passes; add an index, or accept the scan.
