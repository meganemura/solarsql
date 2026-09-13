# ADR 0055: Inspection exposes operation contracts

Status: accepted (2026-09-13)

## Context

Generated TypeScript shows caller types but does not explain all statement uses and database accesses.
An automated caller also needs structured freshness and failure diagnostics.

## Decision

`inspect` performs a build without writes and emits versioned JSON.
It includes catalog locations, parameter and result types, engine column origins, access records, and the local SQLite version.
Access records include indirect reads and writes reported through triggers and foreign keys.
The report distinguishes local analysis from deployment verification.
`build --json` uses the same diagnostic envelope.

## Boundary

Inspection imports application modules. Its no-write claim concerns build artifacts, not arbitrary imported JavaScript.
Engine origins and inferred types remain separate fields.
The format does not claim complete type provenance or a sandboxed execution plan.
