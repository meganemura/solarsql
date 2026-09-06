# ADR 0005: Queries live in a named catalog

Status: accepted (2026-09-06). Since ADR 0033 the catalog lives in the module's one source file, `module.ts`.

## Context

An agent reads an API as a finite list of names with types.
A query that is built at run time has no name and no fixed type.

## Decision

Every query has a name in a catalog object.
The catalog is the API of the module for reads.

## Why

A finite set of queries can be typed one by one from the engine.
An agent reads the catalog the way it reads a function list.

## Consequences

- Ad hoc SQL at run time is out of scope for the typed surface.
- The build step types each catalog entry with the engine (ADR 0010).
