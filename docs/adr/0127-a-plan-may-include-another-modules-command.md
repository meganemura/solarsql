# ADR 0127: A plan may include another module's command

Status: accepted (2026-09-19)

## Context

The ownership study (v5-measurements.md, section 3) found that a write spanning two modules has no atomic shape.
ADR 0027 refuses a cross-module write, so a `t10` command cannot delete `t11`'s rows; `t11` exposes a delete-by-parent command, and the caller runs it and then `t10`'s own delete.
That sequence is two D1 batches or two Durable Object transactions, and the second can fail after the first committed.
Four of six agents found that two-command shape; none made it atomic.

## Decision

A plan item may be another module's exported command, imported from that module's `public.ts`.
The build expands it in place into that command's statements and asserts.

- Provenance: each expanded statement keeps its owning module, so ADR 0027's ownership check applies to each statement under its own module; the including module still writes only its own tables directly.
- Parameters are shared by name across the whole expanded plan, the rule a plan already has; a name with two types is refused, naming both.
- Assert names must be unique across the expanded plan; a collision is refused by the build, naming the two items.
- The included command's `returns` is dropped; only the outer command's `returns` runs.
- `changes()` in an assert still counts the statement right before it in the expanded order.
- The included module builds first: config order, as cross-module public imports already require (ADR 0040's stubs cover the generated file).
- At runtime `commands()` flattens the plan at construction, so the adapters see only statements and asserts and the plan still runs as one D1 batch or one Durable Object transaction; `inspect` and `--json` show the expanded plan with each item's source module.
- The types: `PlanShape` admits a `Command` item; `PlanParams` merges the included command's parameters; `PlanAsserts` merges its assert names.

## Alternative refused

Call-site batching, `db.run(a, b)` in one transaction.
It gives every caller a second way to be atomic, needs a rule in the docs for when to use which, and makes the result a tuple.
It also moves the checks the build does on a plan (parameter types, asserts, ownership, reads, the query plan) to runtime for the pair.

## Consequences

- The build order stays config order; a module that includes another module's command needs that module built first, already true of a public import.
- `PlanShape`, `PlanParams`, and `PlanAsserts` gain the merge rules above.
- `inspect` and `--json` show each expanded item's source module, so a plan's provenance is visible without reading both modules.
- `commands.md` and `SKILL.md` step 4 gain the rule that a plan item may be another module's command.
- A Miniflare test is the claim: a failure in the included command's statement rolls back the including command's own statement on D1 and on a Durable Object, and the mirror case.
- A nested include is refused: a command that includes another command that itself includes a command names both and stops the build with "which itself includes a command; include the inner commands directly"; an agent includes the inner commands directly instead.
- A mutual include is impossible: the build-order rule ("must come before module ... in modules") can hold in only one direction, so module A including module B's command and module B including module A's command cannot both build.
- A SqlValue column of an included statement that the including plan could refine stays SqlValue: the owner's generated file is already written by the time the including module types, so the refinement can only be detected, not written back. This is a real gap, open work.
