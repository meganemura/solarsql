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
| `insert into t (c) values (:p)`, or any later row of a multi-row `values (:p), (:p2), ...` | the type of `t.c` |
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
Parameters compared with CTE, view, or derived-table columns use those columns' inferred types.
Unqualified columns resolve in the local SELECT before an enclosing SELECT.
Each SELECT retains its own WITH bindings, including for correlated references.
A decoded JSON column takes SQL text as a comparison parameter.
Unrecognized parameter expressions retain the `SqlValue` fallback.

## The type of a column

Numeric literals retain SQLite spellings such as `0XFF`, `1_000`, and `1.e2`; each has the `number` type.

The build follows column references through tables, views, CTEs, and derived tables.
Literals, scalar SELECTs, and the JSON shapes below have inferred types.
Other expressions need `cast(... as integer | real | text | blob)`.
CAST accepts SQL comments, whitespace, and enclosing parentheses.
A BLOB cast returns `Uint8Array | null` unless the complete inner expression proves a non-null result.

| Column of the select list | Type |
|---|---|
| a column of a table, or `t.*` | the declared type ([schema.md](schema.md)); `\| null` when an outer join can omit its source |
| a column through a view, CTE, or derived table | its defining query's type, including its nullability and JSON shape (ADR 0048) |
| a scalar SELECT | its single output type, with `\| null` for an empty result |
| a string, number, or NULL literal | the literal's type |
| a BLOB literal, such as `x'00ff'` or `X''` | `Uint8Array` |
| an expression: `count(*)`, `sum(x)`, `a + b`, `bm25(t)`, a window function, a `case` | needs `cast(... as integer \| real \| text \| blob)`; the build refuses it without one |
| `cast(expr as T)` | `T \| null` |
| `cast(<shape> as T)` where the whole `<shape>` is `count(...)`, `total(...)`, `row_number()`, `rank()`, `dense_rank()`, `ntile(...)`, `exists (...)`, `not exists (...)`, `coalesce(x, <literal>)`, `ifnull(x, <literal>)`, `coalesce(x, <col>)`, `ifnull(x, <col>)`, or a bare `<col>`, where `<col>` is a NOT NULL column reference not on the outer side of a join (ADR 0031, ADR 0105), such as `cast(coalesce(b.n, 0) as integer)` | `T`, never null |
| `json_group_array(json_object('k', c, ...))` | `{ k: T; ... }[]`, parsed by the adapter |
| `json_group_array(c)` | `T[]` |
| `json_object('k', c, ...)` | `{ k: T; ... }` |
| `json((select json_group_array(...) from child where child.parent_id = o.id))` inside a `json_object` | a nested array; without the `json()` the column holds JSON text |
| `VALUES` | union of all row types by column position |
| `UNION` or `UNION ALL` | union of branch types by column position (ADR 0048) |
| `INTERSECT` or `EXCEPT` | the left input's types (ADR 0048) |
| `RIGHT JOIN` or `FULL JOIN` | source types with nullability for each side that can be absent (ADR 0048) |

A JSON constructor must span the complete expression, with supported FILTER or OVER clauses for an aggregate.
An enclosing scalar expression such as `length(json_object(...))` needs an explicit CAST.
The CAST result keeps its scalar type and skips JSON decoding.

Repeated literal keys in `json_object` use the last value and its type, matching the decoded object.
Literal keys can include SQL comments and enclosing parentheses; dynamic keys require a different query shape.

Inside JSON constructors, a BLOB or flexible storage value has the recursive `JsonValue` type.
SQLite can decode valid JSONB into objects, arrays, scalars, or null.
Invalid binary content can still cause a SQLite error.
An ordinary BLOB query returns `Uint8Array`; an explicit TEXT conversion inside JSON keeps its text type.

`json_group_array` accepts DISTINCT and aggregate-local ORDER BY terms, such as `json_group_array(distinct c order by c desc)`.
These clauses change the result values and order; they retain the inferred element type.
SQLite validates combinations with FILTER and OVER.

A `json_group_array` over the null-producing side of a `left join`, a `right join`, or a `full join` needs `filter (where l.id is not null)`, or a parent with no children gets one null element (ADR 0011, ADR 0111). `coalesce(..., '[]')` gives the empty array.
Only an exact `filter (where alias.column is not null)` removes that alias's outer nullability from the generated array element type (ADR 0047).
Other predicates retain conservative nullability; filtering one alias does not narrow another alias.

Each catalog query contains one SELECT or VALUES statement, optionally preceded by WITH.
The build refuses writes and multiple statements in a query entry; put writes in command plan items.
Each output column needs a distinct name; use AS to distinguish columns with the same name.
Wildcards expand their source columns, including CTEs and derived tables.
Recursive CTEs with a SELECT or VALUES seed and UNION branches are supported when their result types stabilize.
Unresolved structural forms fail with a build error.
A compound output that mixes decoded JSON and ordinary SQL values requires a common decoding policy.
CAST the JSON branch AS TEXT to return SQL text from that output.

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

Named parameters can use `:`, `@`, or `$`. A single `:id` or `@id` uses the caller key `id`.
When a statement contains both `:id` and `@id`, supply `{ ":id": 1, "@id": "text" }` with the generated types.
Colliding keys retain their prefixes until each key is distinct. Repeated full names share one value.
These keys belong to each statement contract; changing a collision requires updating its callers.
SQL text and SQLite slot order stay unchanged (ADR 0071).
