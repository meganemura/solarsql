# ADR 0007: Rows are plain values with a one-way dependency

Status: accepted (2026-09-06)

## Context

ADR 0002 lists the four properties that serve a coding agent.
Property three says that nothing runs that the calling line does not show.
Property four says that a value carries no hidden state.

## Decision

A row is a plain object with typed fields.
A row has no methods and no callbacks.
Dependencies point one way: command depends on query, query depends on table.

## Why

A method on a row runs code that the calling line does not show.
A callback on save runs code that the caller cannot see.
A one-way dependency lets an agent read a command without reading the table module first.

## Consequences

- Commands and queries hold all behavior.
- A row can cross a module boundary as data (ADR 0008).
