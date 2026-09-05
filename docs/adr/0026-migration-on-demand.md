# ADR 0026: The build checks migrations, and a separate command writes one

Status: accepted (2026-09-06)

## Context

ADR 0013 generates a migration from the difference between the files and the schema.
An agent edits the schema several times before the change is final.
A file written on every build would pile up.

## Decision

`solarsql build` compares the migration files with the schema and fails when they differ, with the statements it would write.
`solarsql migration <name>` writes the next numbered file and the bundle `migrations/index.ts`.

## Why

The build stays a check that an agent runs freely.
The migration is a deliberate step with a name.

## Consequences

- The bundle file lives inside the migrations directory. wrangler lists `*.sql` there and ignores it.
- A blocked migration (an ambiguous rename, a NOT NULL column without a default) fails both commands with the same message.
