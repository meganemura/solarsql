# ADR 0033: A module is three files: its source, its public file, and its generated file

Status: accepted (2026-09-06). Changes the file layout of ADR 0005, ADR 0006, and ADR 0008; ADR 0025 stays.

## Context

Version 1 gave a module five files: `schema.ts`, `queries.ts`, `commands.ts`, `public.ts`, and `solarsql.generated.ts`.
Changing one operation required an agent to inspect the three authored files before it could find the schema, queries, and commands.
Those definitions form one module and change together.

## Decision

A module is three files.
`module.ts` holds the schema (tables, indexes, views, triggers), the queries, and the commands, in that order.
`public.ts` holds what other modules may import (ADR 0008).
`solarsql.generated.ts` is written by the build (ADR 0025).
The build imports `module.ts` and reads every export by its kind.

## Why

A module is one thing its author writes, one face it shows, and one file the build writes back.
That is the shortest description of the layout, and it is the description an agent with an empty context needs.
`public.ts` stays a file of its own because the import check and the boundary rest on it.
The generated file stays a file of its own because the build rewrites it whole.

## Consequences

- An agent finds all authored module definitions in `module.ts`.
- A long module is one long file. A module that grows past reading in one sitting is split by its tables (ADR 0008).
- The example follows the new layout.
