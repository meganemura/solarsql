# ADR 0035: Several reads go in one D1 round trip through db.batch

Status: accepted (2026-09-06). Extends ADR 0030: the number of round trips is the data layer's.

## Context

D1 sits across a network from the Worker, and each query is one round trip.
A page that shows an order, its lines, and the customers runs three queries, so three round trips.
D1's `batch()` sends several statements in one round trip, and a command already uses it for its plan.
ADR 0030 leaves concurrency to the caller, and `Promise.all` over three queries is still three round trips.

## Decision

`db.batch([read(q1, params1), read(q2, params2)])` runs the queries and returns their rows by position, each with the row type of its query.
`read()` checks the parameters against its query, so the batch needs no check of its own.
On D1 the batch is one `batch()` call.
On a Durable Object and on node:sqlite the storage is local, and the reads run in order.
The observe hook sees one event of kind `batch`, named by the queries joined with `+`.

## Why

The number of round trips is a property of the data layer, not of the application's program model.
A batch of reads is the same shape on every adapter, so a module written against `Database` runs on all three.

## Consequences

- A batch is reads only. A write with a rule is a command (ADR 0006).
- D1 runs the statements of a batch in one transaction, so the reads see one state.
- A read that fails throws for the whole batch, like a single query.
