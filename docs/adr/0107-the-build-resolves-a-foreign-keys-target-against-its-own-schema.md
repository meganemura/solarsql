# ADR 0107: The build resolves a foreign key's target against its own schema

Status: accepted (2026-09-15). Adds two refusals to table validation.

## Context

Commit `39224f9` ("Resolve a table's foreign keys against the schema the build already has") added two refusals to the build's table-validation loop, before this record existed. `pragma_foreign_key_list` echoes whatever a `REFERENCES` clause declares, with no check that the target resolves: a stale or misspelled target would otherwise pass every build check, apply cleanly as a migration, and only fail on the table's first write in production.

Neither existing ADR admits this. ADR 0046 constrains an automatic rebuild's `ON DELETE` actions on an incoming foreign key, a different failure mode: it fires when a rebuild would run a delete action against real rows, not when a foreign key's own target is undeclared. ADR 0064 is a different mechanism: it reads a table's kind, `STRICT`, and `WITHOUT ROWID` from `pragma_table_list`, not a `REFERENCES` clause's target from `pragma_foreign_key_list`.

## Decision

The build refuses a table whose foreign key names a target table no module declares: `table <t> has a foreign key to <target>, which no module declares. Fix the table name, or declare the missing table.` It also refuses a foreign key whose target column does not exist on that table (an omitted column list resolves to the target's own primary key first): `table <t> has a foreign key to <target>(<col>), which has no such column. Fix the column name, or declare it on <target>.`

## Why

The build already has every module's schema in memory at this point; resolving a foreign key's target against it, at the same time it resolves everything else, costs nothing and moves a failure that would otherwise happen at the table's first write to before the migration ever applies.

## Consequences

- A foreign key to a genuinely undeclared table or column is a build-time error, not a runtime one.
- This adds two refusals to table validation. Neither ADR 0046 nor ADR 0064 is edited.
