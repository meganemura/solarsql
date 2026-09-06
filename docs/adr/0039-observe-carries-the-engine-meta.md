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
