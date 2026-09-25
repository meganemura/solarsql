# ADR 0136: json_group_array refuses a join that can multiply its elements

Status: accepted (2026-09-25). Extends the scanner facts of ADR 0020, the way ADR 0048 (unique-index facts) already did. ADR 0011 refuses the other silent `json_group_array` error (the null element from an unfiltered outer join); this refusal is about a repeated element instead.

## Context

An agent can extend the documented `withLines` idiom (`queries.md`, `example/modules/orders/module.ts`) with a second one-to-many child, joined instead of moved into its own correlated subquery. The query builds, types non-null, and returns a duplicated array.

Measured on node:sqlite 3.53.4 with `order_events(id, order_id, kind)` added to the example schema:

```sql
select o.id,
  json_group_array(json_object('id', l.id, 'sku', l.sku)) filter (where l.id is not null) as lines,
  json_group_array(json_object('id', e.id, 'kind', e.kind)) filter (where e.id is not null) as events
from orders o
left join order_lines l on l.order_id = o.id
left join order_events e on e.order_id = o.id
where o.id = :id
group by o.id
```

builds with non-null arrays. Order `o1` has 2 lines and 3 events; `lines` has 6 elements (`l1,l1,l1,l2,l2,l2`) and `events` has 6. An INNER JOIN variant gives the same 6. `json_group_array(distinct ...)` gives 2 and 3. A "descendant" shape also builds today: an aggregate over `orders`, grouped by `customer`, with `left join order_lines l on l.order_id = o.id` also present, returns each order once per line. Miniflare D1 and a local Durable Object return the same values as node:sqlite.

The rule must not refuse a correct query. Measured, all three still build after this ADR: the bridge-table many-to-many `posts p left join posts_tags pt on pt.post_id = p.id left join tags t on t.id = pt.tag_id group by p.id`, aggregated over `t` (`posts_tags` has a composite primary key, so its own row count is not 1 per group -- it does not need to be, since its own parent, `p`, is what is grouped); `customers c left join orders o ... left join order_lines l ... group by c.id`, aggregated over `l`; and `withLines` plus `join customers c on c.id = o.customer_id`.

## Decision

For the aggregate's own alias set `A` (every alias its element or its FILTER references), the build walks each visited alias's own ON clause to the alias on its "other side," collecting the walked set. An alias the walk reaches while it still carries its own ON clause needs no separate proof (a bridge table's own row count need not be 1 per group, as long as its own parent is safely identified in turn). An alias the walk reaches with no ON clause of its own -- the walk's own terminus, including the FROM root -- is not exempt this way; the join structure alone says nothing further about it.

Every alias not in `A`, and not exempt by the walk, must be provably at most one row per group:

- An alias with its own ON clause is proven when that clause equates every column of its primary key, or of one of its own unique indexes, with an expression that does not reference it. The unique index must be non-partial, every key column a plain column (not an expression), and its declared collation must match the ON clause's own comparison collation (an explicit `COLLATE` in the clause, else the column's own declared collation).
- An alias with no ON clause of its own is proven by GROUP BY (listing every column of such a key) or, when the containing SELECT has no GROUP BY at all -- the shape a correlated one-to-many subquery already uses, `where root.id = :id` or a correlated `where root.id = outer.id` -- it needs no proof: with no GROUP BY, it is the query's own iteration, not a second dimension crossed against another, and cannot itself multiply an aggregate's elements.

`json_group_array(distinct ...)` is exempt: DISTINCT already removes any duplicate a fan-out join would add. The build refuses whenever it cannot show an alias is safe this way, the same conservative stance ADR 0047 already takes for scope resolution.

New scanner facts this decision needs:

- `Source.on` (`scope.ts`): a FROM source's own ON clause text, which `querySources` had never captured (only USING and the join keyword).
- `onEqualities` (`scope.ts`): from an ON or WHERE clause, the columns of one alias that a depth-0 AND chain equates against an expression not referencing that alias, with each equality's own explicit COLLATE override; `null` when a depth-0 OR sits in the clause (unprovable, the same reasoning `unconditionalMatchAliases` already applies to WHERE).
- `TableFact.uniqueIndexes` and `ColumnFact.collation` (`facts.ts`): every non-partial, non-expression unique index (`pragma_index_list` origin `u`/`c`, `pragma_index_info`, `pragma_index_xinfo`), and a column's own declared COLLATE, read from its definition text since no pragma reports a plain column's own collation.

## Consequences

- The measured `lines`/`events` sibling-join query, and the descendant-fan-out query, now fail the build; the message names the multiplying alias and the correlated-subquery remedy (the recipe ADR 0132 added).
- The bridge-table many-to-many, the customers-through-orders-through-lines aggregate, `withLines` alone, and `withLines` plus a primary-key join to `customers`, are all still measured to build, decode, and return the right values.
- A one-to-many join an agent writes without a correlated subquery now needs a provable unique key on every extra joined alias, or the build tells the agent why not and what to write instead.
