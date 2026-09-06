# ADR 0027: What the boundary check sees

Status: accepted (2026-09-06). Extended the same day: a module may also read the foreign key columns of the tables that reference its own tables, because a delete from a parent table reads them (found by the `clear` commands of ADR 0036). Extended again the same day: an index sits on a table of its own module, and the build refuses one on another module's table, as it refuses a trigger.

## Context

ADR 0009 checks every table access a statement makes.
The authorizer reports table-valued functions and pragmas as table names: `json_each`, `pragma_table_info`.
A foreign key check reads the primary key of the parent table.
A report needs every table.

## Decision

The check covers only the tables the schema declares.
A module may read the primary key columns that its own foreign keys reference.
A module with `readsAll` may read every table.
The guard table is open to every module.

## Why

`json_each(:lines)` is the way to insert many rows in one statement of a plan, and it must pass.
A foreign key is a reference by id, and the id is the public surface of a module (ADR 0008).

## Consequences

- A write into another module's table always fails, with or without `readsAll`.
- The message names the owner and points at its `public.ts`.
