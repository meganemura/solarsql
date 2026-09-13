# ADR 0030: The program model stays with the caller, and failures are values

Status: accepted (2026-09-06). Supersedes the last paragraph of ADR 0023: a constraint failure is a value too. Extended by ADR 0039: the observe hook carries D1's meta.

## Context

solarsql is a data layer for a Worker that talks to D1 or to a Durable Object.
The caller owns concurrency, retry, observation, dependency injection, and resource cleanup.
The data layer must expose enough information for those responsibilities.

## Decision

| Concern | Where it lives | What solarsql exposes |
|---|---|---|
| Concurrency | The caller. A plan is one request. A Durable Object is single-threaded. | Nothing. |
| Retry | The caller. A retry is a policy of the application. | Failures as values with a kind, so the caller can tell a rejected row from a broken connection. |
| Observation | The caller's tracer or logger. | An `observe` hook on the adapter: name, kind, milliseconds, outcome, per call. |
| Dependency injection | The caller. A module function takes `db: Database`. | The `Database` type, the same on both targets. |
| Resource cleanup | Nothing to clean. D1 has no connection, a Durable Object owns its storage. | Nothing. |

A command result has one discriminant beside `ok`:

```ts
{ ok: true; rows: Row[] }
| { ok: false; kind: "assert"; assert: "has_lines" | "was_draft" }
| { ok: false; kind: "unique"; table: string; columns: string[] }
| { ok: false; kind: "check"; constraint: string }
| { ok: false; kind: "not_null"; table: string; column: string }
| { ok: false; kind: "foreign_key" }
| { ok: false; kind: "datatype"; table: string; column: string; stored: string; declared: string }
```

Every other engine error is thrown.

## Why

A unique index is the real guard against a duplicate (ADR 0012), and its failure is as normal an outcome as an assert.
An assert before the insert races with a concurrent write; the value from the index does not.
The failure kinds come from the engine's message, which has the same form on node:sqlite, D1, and a Durable Object.
The adapter exposes the result, error, and observation data that the caller needs for its program model.

## Evidence (v2)

The seven constraint kinds produce the same message on the three engines, with a `D1_ERROR:` prefix and an `(extended: ...)` suffix on the Cloudflare side.
On both targets the example returns `{ ok: false, kind: "unique", table: "customers", columns: ["email"] }` for a duplicate email, and the observe hook records `command create unique`.
See v2-measurements.md, section 3.

## Consequences

- A `switch` on `kind` is exhaustive over the assert names of the plan and the five constraint kinds.
- The observe hook receives the catalog name of the query or command, so a span or a log line needs no SQL text.
