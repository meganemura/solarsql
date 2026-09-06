# ADR 0025: One generated file per module, committed

Status: accepted (2026-09-06). ADR 0033 keeps this file as one of the three files of a module.

## Context

ADR 0008 bounds what an agent reads by the size of a module.
The generated types are the readable form of what the engine said about the module's SQL.

## Decision

`solarsql build` writes `solarsql.generated.ts` into the directory of each module.
The file holds the id types of the module's tables, the type map keyed by SQL text, and the runtime metadata.
It imports the id types it uses from the generated files of other modules.
The file is committed.

## Why

An agent that opens a module sees the generated types next to the SQL they describe.
The import lines of the generated file show which other modules the SQL depends on.
A committed file lets `tsc` pass right after a clone, and a stale file fails `tsc` until the build runs.

## Consequences

- A build before the first generated file writes a stub, so the module imports.
- The runtime metadata (parameter order, JSON columns) lives in the same file, so an adapter needs no map of its own.
