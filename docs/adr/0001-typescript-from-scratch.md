# ADR 0001: Build in TypeScript from scratch

Status: accepted (2026-09-06)

## Context

The library needs call sites where the selected SQL and its effects are visible.
A coding agent must be able to read a module without hidden row behavior.

## Decision

solarsql is a new TypeScript library.
Its API starts from its SQL, module, and command model.

## Why

The API can make every effect visible at the call site.
It can keep rows as values and keep SQL as the execution contract.

## Consequences

- Users declare schemas and queries in the library's module model.
- The library keeps a focused public surface.
