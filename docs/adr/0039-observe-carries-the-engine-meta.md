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
