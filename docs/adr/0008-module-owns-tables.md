# ADR 0008: A module owns its tables and shows one public file

Status: accepted (2026-09-06). ADR 0033 keeps `public.ts` as the one file other modules import, and folds the rest of the source into `module.ts`.

## Context

A context window is a bounded context.
The amount an agent must read to change a module must be bounded by the size of that module.

## Decision

A module owns its tables.
Other modules read only the file `public.ts` of that module.
The public surface lists id references, queries that return plain types, and commands.
The public surface does not export the row types of the owner.

## Why

When module A changes a table and keeps its public surface, module B does not break.
An agent that works in B reads B and the public files of the modules B uses.

## Consequences

- Cross-module joins go through the public surface, or through a module that declares read access to all tables (ADR 0009).
- Row types of the owner stay private, so a table change stays local.
