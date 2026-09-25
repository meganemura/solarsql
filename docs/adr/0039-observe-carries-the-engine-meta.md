# ADR 0039: The observe hook carries D1's meta

Status: accepted (2026-09-06). Extends ADR 0030.

## Context

D1 answers every statement with a `meta`: the rows it read and wrote, its own duration, and the region that served it.
D1 bills on the rows read and written.
The adapter read `results` and dropped the rest, so a tracer on the observe hook saw the time of a call and nothing of its cost.

## Decision

`Observed` gains an optional `meta`: `{ rows_read, rows_written, duration, served_by_region?, served_by_primary? }`, under the names D1 uses.
A query carries the meta of its reply.
A batch and a command sum the rows and the duration of their statements, and take the region and the primary flag from the first reply.
A Durable Object and node:sqlite report none, and the field is absent; a call that threw has none either.

## Why

The hook is where a logger or a tracer looks (ADR 0030), and the cost of a call belongs next to its time.
D1's names stay, so a reader of D1's documentation and a reader of the hook see one vocabulary.
Sums, because a command is one transaction and its cost is the cost of the whole.

## Consequences

- `D1Like` accepts a `meta` on a reply; a binding without one still fits.
- The local D1 of Miniflare reports the meta too, so the example test checks it on D1 and its absence on the Durable Object.

## 2026-09-19: a Durable Object's SQL cursor reports rows_read/rows_written too

Cloudflare's Durable Objects Storage API documents `SqlStorageCursor.rowsRead` and `rowsWritten` for cost accounting, and Miniflare confirms it: an insert cursor reports `rowsWritten`, a select cursor reports `rowsRead`, and reading `.toArray()` first does not change either value. The "reports none" line above was written before this was checked.

`observe()` now sums these across the cursors a query, batch, or command touches, and reports them under D1's own `rows_read`/`rows_written` names, the same both-required rule `engineMeta()` already applies to a D1 reply: reported only when at least one cursor gave both as numbers.

`duration` stays D1 only. D1 reports its own server-side timing; a Durable Object's storage API has no corresponding value, and reporting 0 would claim a duration that was never measured. `EngineMeta.duration` is optional for this reason, and a Durable Object's meta omits it rather than fabricating it.

node:sqlite still reports no meta at all: `node.ts`'s storage shim fabricates a cursor with only `toArray()`, and has neither counter to report.

## 2026-09-25: `statements`, the same rows per plan item, not summed

`meta` above answers "how many rows did this whole call cost", summed. A caller who sees a high `rows_read` on a multi-statement command or batch cannot tell which one statement read them, and the build's own scan check (`BuildResult.scans`) reads an empty, freshly built schema with no `ANALYZE` statistics (ADR 0122), so it cannot stand in for what a deployed database actually did.

Both production engines already report rows per statement, not only summed: D1's `batch()` replies one `D1Result` per statement, each with its own `meta` (measured on Miniflare: a 3-statement command got `rows_read` `0, 1, 0` and `rows_written` `2, 1, 2`, one reply per statement, in order -- https://developers.cloudflare.com/d1/worker-api/return-object/). A Durable Object's each `SqlStorageCursor` carries its own `rowsRead`/`rowsWritten` (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/); `src/durable.ts` already held one cursor per call, just summed together.

`Observed` gains an optional `statements`: one `{ rows_read, rows_written, duration? }` per plan item (a statement or an assert), in expanded-plan order, then one more for `returns` when the command has one; one per read for a batch. Guard cleanup and a Durable Object's `total_changes()` probes are not plan items and get no entry, so index `i` always means position `i + 1`. Reported only when every entry carries both counters -- the same both-required rule `meta` and `engineMeta()` already apply -- so a partial reply never leaves a caller guessing which index a hole belongs to. `duration` is D1 only, the same reason `meta.duration` is D1 only: a Durable Object's synchronous statement has no server-side timing to report, and a Worker's `performance.now()`/`Date.now()` only advances after I/O on a deployed Worker (https://developers.cloudflare.com/workers/runtime-apis/performance/), so measuring it here would report a false 0, which this ADR already refuses for the summed field.

D1's own guard-cleanup reply (last, when present) is dropped by slicing to the plan's own statements plus `returns` before building the field; a Durable Object collects a second, narrower cursor array (`itemCursors`) alongside the one `cursorMeta()` sums from, so the probe and cleanup cursors never join it. The summed `meta` field is unchanged: both adapters still report it from the full cursor or reply set, cleanup and probes included, the way `changes` already only counts the plan's own rows while `meta` counts everything the call touched.

`observed()`'s `report()` callback (`src/runtime/plan.ts`) now takes an object (`{ meta?, at?, statements? }`, ADR 0137's `at` alongside this) and merges each call into an accumulated state, rather than taking one value at the end: `statements` is reported once, at the end of a successful call, the same as `meta`; `at` (ADR 0137) is reported and cleared item by item, sharing this same mechanism so the two features do not each open their own report channel.

`running.md` documents the field and its D1/DO/node availability alongside `at`.

`test/observe-statements.test.ts` pins this in-process, on D1 and Durable Object fakes and on node. `test/miniflare/observe-plan-item.test.ts`, against real D1 and a real Durable Object (`test/observe-plan-item.worker.ts`), pins a 3-item plan plus `returns` giving 4 entries on both engines, D1's with a numeric `duration` on every entry and the Durable Object's with none, and a failed call on either engine giving no `statements` field.
