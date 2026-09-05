# ADR 0004: Schema and queries are SQL in tagged templates

Status: accepted (2026-09-06)

## Context

An agent writes `CREATE TABLE` and `SELECT` with more fluency than any builder API.
SQLite has no `COMMENT ON`, so documentation cannot live in the database.

## Decision

The schema is SQLite DDL inside a tagged template in `schema.ts`.
Queries are SQL inside tagged templates in `queries.ts`.
Names and documentation are TypeScript values next to the SQL.

## Why

SQL is the language the agent already knows.
A name that is a TypeScript identifier gets its spelling checked by `tsc`.
Documentation as a TypeScript value stays next to the table it describes.

## Consequences

- The library needs no query builder.
- A `${...}` inside a template is typed as a parameter or as an identifier reference (ADR 0010).
- Types for a query come from the engine, so the SQL text is the source of truth (ADR 0010).
