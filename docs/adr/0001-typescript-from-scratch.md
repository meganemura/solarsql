# ADR 0001: Build in TypeScript from scratch

Status: accepted (2026-09-06)

## Context

Existing ORMs carry implicit behavior: lazy loading, callbacks, default scopes, and identity maps.
Each of these makes a row do something that the calling line does not show.
A coding agent that reads one file cannot see that behavior.

## Decision

solarsql is a new TypeScript library.
It does not keep compatibility with any existing ORM or query builder.

## Why

Removing implicit behavior from an existing library is harder than not adding it.
A layer on top of an ORM inherits the behavior of the ORM.
A new library can make every effect visible at the call site.

## Consequences

- Users do not migrate from another ORM by adapter. They write the schema and the queries again.
- The library stays small. It has no compatibility surface to maintain.
