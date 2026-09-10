# ADR 0042: The command result counts the rows it changed

Status: accepted (2026-09-11). Extends ADR 0006.

## Context

A bulk writer can use `insert or ignore ... from json_each(:rows)` to accept many rows in one statement.
Its `{ ok: true, rows: [] }` result cannot show whether it wrote rows or skipped them all.
An assert was the only available count, but a false assert rolls back the plan.

## Decision

The successful command result gains `changes`, the number of rows that the plan's statements inserted, updated, or deleted, the rows their triggers wrote included.
The adapter sums the count of each SQL statement of the plan.
An assert and the `returns` query add nothing.
A plan that changes no rows reports 0.

## Why

Each engine reports the count without extra application work.
D1 reports it in `meta.changes`, which is the difference of `total_changes()` around the statement, so a trigger's rows are in it; the Durable Object adapter takes the same difference, so the three adapters agree.
`changes()` was refused for the Durable Object: it leaves a trigger's rows out, and the count would differ from D1's for the same plan.
The sum over the plan is the one number that a caller reads after one transaction.

## Consequences

`rows` and `changes` are independent.
The deployed example Worker reports `changes` only after a redeploy.
