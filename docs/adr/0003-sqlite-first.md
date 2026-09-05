# ADR 0003: SQLite is the first engine

Status: accepted (2026-09-06)

## Context

Cloudflare runs SQLite in two places: D1 and Durable Objects.
D1 executes a list of statements as one batch.
A Durable Object executes SQL synchronously inside `transactionSync()`.
These are two execution models on one engine.

## Decision

SQLite is the first-class engine.
Version 1 covers D1 and Durable Objects.
Postgres comes later as an adapter behind an engine seam.
The seam has three parts: the SQL scanner, the type oracle, and the execution model.
The library does not translate SQL between dialects.

## Why

The two Cloudflare execution models already force the seam in version 1.
A seam that separates D1 from Durable Objects can also separate SQLite from Postgres.
Translation between dialects would hide the SQL that runs, which breaks ADR 0002.

## Evidence (v0)

node:sqlite in Node 26.7.0 and workerd 1.20260828.1 both embed SQLite 3.53.4.
See v0-measurements.md, section 1.

## Consequences

- The type oracle for the inner loop is node:sqlite (ADR 0014).
- Postgres support adds an oracle and an execution model, and keeps the plan model.
