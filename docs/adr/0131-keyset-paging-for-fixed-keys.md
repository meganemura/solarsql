# ADR 0131: Keyset paging for a fixed key, OFFSET only for a jump or a chosen sort

Status: accepted (2026-09-25). Partially supersedes ADR 0028's paging row: `limit :limit offset :offset` remains the idiom for a jump to page N or a parameter-chosen sort; a page that always walks forward from the last row it saw uses keyset paging instead.

## Context

`skills/solarsql/references/queries.md` taught one paging recipe, `select id from orders order by id limit :limit offset :offset`, the idiom ADR 0028 named. The build does not flag it: the scan report only runs for a SELECT with a WHERE clause. The example's own `orderQueries.search` uses OFFSET, and nothing told an agent that a growing OFFSET grows the bill.

Measured on Miniflare D1 (`spike/14-keyset-paging.test.ts`, 20,000 rows, a text primary key, 100-row pages):

| Page k (0-indexed) | OFFSET `rows_read` | keyset `rows_read` |
|---|---|---|
| 0 | 100 | 100 |
| 10 | 1,100 | 100 |
| 100 | 10,100 | 100 |

`where id > :after order by id limit :limit` costs 100 rows_read at every depth; `limit :limit offset :offset` grows by 100 for every page and is capped at the table's row count once the offset exceeds it. A composite (row-value) form, `where (g, id) > (:after_g, :after_id) order by g, id limit :limit` over an index on `(g, id)`, cost 101 rows_read at page 10 and 100: the engine reads one row past the previous page's last row before the two-column comparison admits the first row of the new page.

The ticket that opened this ADR also measured, on node:sqlite with a 100,000-row table: a full walk visits 50,050,000 rows with OFFSET against 100,000 with keyset; a deleted row shifts an OFFSET page's start (page 2 begins at row 102 instead of 101) while a keyset page still starts at the first surviving row past the cursor; the expanded `OR` form of a composite comparison (`created_at > ?1 or (created_at = ?1 and id > ?2)`) read 3,665 rows at page 500 against 101 for the row-value form `(created_at, id) > (?, ?)`; and `(:after is null or id > :after)`, written to make the first page and later pages one query, costs the same as OFFSET and the build reports it as a scan, because the OR disables the index the same way ADR 0028's optional-filter idiom does.

D1 bills scanned rows (Cloudflare's D1 pricing page, note 1, checked 2026-09-25); the Free plan includes 5,000,000 rows read per day. The build's own scan report (`skills/solarsql/references/queries.md`, "What the build reports") only fires for a WHERE clause the engine still scans in full; `limit ... offset ...` alone gives it nothing to flag, which is why this idiom needed a written rule instead of a build check.

Two further constraints from the ticket:

- The last key column must be unique, and every key column NOT NULL: a row-value walk on a nullable column returned 100 of 1,000 rows and stopped once the first page sorted the NULL rows first (SQLite's default), and a walk that starts from a non-NULL `:after` skips every NULL-key row.
- Every key column must sort the same direction: `order by c desc, id asc` with `(c, id) < (?, ?)` returned the wrong page on node:sqlite, because a row-value comparison tests one direction for every column it spans.

`newId()` makes UUID v7 ids (`skills/solarsql/references/running.md`), but `src/runtime/id.ts` keeps `lastMs` and `counter` per isolate: an id sorts in creation order within the isolate that made it, and across isolates only by millisecond, so a keyset walk over `newId()` values is not a strict creation-order walk once more than one isolate writes.

## Decision

`queries.md`'s Recipes section teaches keyset paging as the default for a page that only ever walks forward: a first-page query with no WHERE clause and a next-page query keyed on `:after`, the same two-query pattern ADR 0028 already uses for an optional filter. It states the three rules above (NOT NULL, unique last column, one sort direction) and gives the composite (row-value) form with its index, and the same-direction `desc` form. It warns against the expanded OR form and against `(:after is null or id > :after)`, both of which read like OFFSET because both disable the index.

The OFFSET recipe stays, named for what keyset cannot do: jump to an arbitrary page N, or serve `order by case :sort when ...`. Its entry states the cost: it reads and bills every skipped row, and it can skip or repeat rows when rows are inserted or deleted between calls, because it counts position, not identity.

`queries.md`'s parameter-type table gains a row for the composite comparison operators `<`, `>`, `<=`, `>=` on a row-value tuple: each types its right-hand parameters by position, the same rule the table already states for `=`.

`example/modules/orders/module.ts` gains `firstPage` and `nextPage`, a single-column keyset pair over `orders.id`, which is already indexed as the primary key and needs no new index or migration.

`limits.md`'s "Maximum response size or rows per query" row keeps "Not stated" and adds: D1 bills scanned rows (Cloudflare's D1 pricing page, note 1, checked 2026-09-25); the Free plan includes 5,000,000 rows read per day; and query execution and result serialization run within the Workers isolate's 128 MB memory limit (Cloudflare's D1 limits page and Workers platform limits page, checked 2026-09-25), which bounds how large one page's result can be regardless of the row count keyset paging reads. The row points to `queries.md`'s keyset recipe as the way to keep a page's own read bounded.

## Why

A page that only ever walks forward has no reason to pay for the rows it skips: the index already knows where the last page ended. Keyset paging reads that cost from the index directly, `where id > :after`, instead of counting position. OFFSET's one advantage, jumping to an arbitrary page, is also its cost: counting to page N means reading every row before it.

The composite form's one extra row (101 against 100) is the price of a row-value seek finding the boundary between the previous page and this one; it is still bounded, unlike OFFSET's page-times-limit growth.

## Consequences

- `orderQueries.search`, the example's own OFFSET-based query, is unchanged: it takes a chosen sort and a chosen status, which keyset cannot serve, so it stays the documented exception, not a mistake to fix.
- A caller that pages by `newId()` values across more than one isolate sorts by millisecond only for ties; a caller that needs exact creation order across isolates needs a second column, not `id` alone.
- The `test/keyset-paging.property.test.ts` Hegel properties, and the `test/miniflare/keyset-paging.test.ts` / `test/keyset-paging.worker.ts` fixture, pin the two claims this ADR rests on: a keyset walk equals one unpaged read and survives deletes ahead of the cursor, and a keyset page's `rows_read` stays flat while an OFFSET page's grows with `offset + limit`.
- The build still does not flag `limit ... offset ...` on its own; this ADR's rule is the only place besides queries.md an agent can read the cost from until such a check exists.
