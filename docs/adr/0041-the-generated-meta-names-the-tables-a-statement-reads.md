# ADR 0041: The generated meta names the tables a statement reads

Status: accepted (2026-09-10). Extends ADR 0025.

## Context

The generated file carries, per statement, what the adapter needs at run time: the parameter order, the parameters to encode, and the JSON columns (ADR 0025).
The build already asks the engine which tables every statement reads, for the boundary check (ADR 0009).
A caller that picks a data source by table, or drops a cache by table, needs the same list at run time.
Without it, the caller prepares the statement on a schema of its own with an authorizer, which is the build's probe done again outside the build.

## Decision

Every entry of the generated meta gains `reads`: the names of the tables of the schema the statement reads, sorted, once each.
A table counts when the statement reaches it directly, through a view, through a trigger the statement fires, or by a foreign key check.
A view, a table-valued function such as `json_each`, a `pragma_*` function, and the guard table of the asserts do not appear.
A search table appears under its own name.
`Query.meta.reads` and `Command.meta.statements[i].reads` carry it; `StatementMeta` has the field.

## Why

The engine reports the reads at prepare, and the build has the schema, so the list costs one more pass over facts the build holds.
The declared tables are the ones that hold rows; a view and a function are ways to read them, and a caller that routes or invalidates cares about the rows.
A trigger body and a foreign key check are reads the engine performs for the statement, so the list says what happens, not what the text shows.

## Consequences

- The generated file gains a field, so a project that upgrades runs `npx solarsql build`; `tsc` names the generated file until then, and `build --check` reports it stale.
- The adapters read no `reads`; the field is for the calling code.
- A read of a table outside the declared schema, such as a table of another database, is not listed, since the build does not know it.
