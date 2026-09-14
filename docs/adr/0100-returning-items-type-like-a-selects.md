# ADR 0100: A DML statement's RETURNING items type by the same rules as a SELECT's

Status: accepted (2026-09-15)

## Context

`Typer.analyze` computes the output columns of a SELECT by walking its item list, so a computed expression, a CAST, or a JSON constructor gets a real type from the same rules everywhere (`outputColumn`, `jsonArrayType`, `jsonObjectType`).
For an INSERT, UPDATE, or DELETE statement, it instead calls `outputColumn` once per RETURNING output with the item hard-coded to `null`.
A bare column reference in RETURNING still resolves, because SQLite's own prepared-statement metadata already names its table and column.
Every other RETURNING expression — a CAST, an arithmetic expression, a JSON constructor — has no item to read, so `outputColumn`'s CAST and JSON branches never run, and the statement fails with "column is an expression with no type", even when the RETURNING clause already contains the exact CAST that message asks for.

`Engine.affinities`, the other input a non-column expression needs, wraps its argument as `select * from (${sql}) limit 0` to read the type SQLite would store.
That wrapping is invalid SQL for INSERT, UPDATE, and DELETE (confirmed: SQLite rejects it with a syntax error), so even a fixed item list would have no affinity source to resolve a computed RETURNING expression's type.

A RETURNING clause has exactly one row source: the table the statement writes to.
It has no join, so it has no nullable side: whatever nullability rule `castNeverNull` already applies to a SELECT's CAST holds unchanged for RETURNING on INSERT and UPDATE, whose row exists by the time RETURNING reads it, and on DELETE, whose row is the one it just removed. `castNeverNull` itself only recognizes `EXISTS`/`NOT EXISTS`, a fixed set of aggregate and window calls, and `coalesce`/`ifnull` when the last argument is a literal or a column its own lookup finds declared NOT NULL; a CAST wrapping a bare column reference with no call around it is not one of those shapes, so it types nullable today in a SELECT (confirmed: `select cast(qty as text) as t from orders`, `qty` declared NOT NULL, types `string | null`) and types nullable in RETURNING for the same reason, not a new one.

## Decision

A DML statement's RETURNING items type by the same rules a SELECT's items do, with the statement's one write-target table standing in for the FROM list.

`Typer.analyze`'s non-SELECT path now parses the RETURNING clause's item list (the text after the statement's own top-level `RETURNING` keyword, found the way `accesses()` already finds the write target, not by string search) with the same item parser a SELECT's list uses.
A bare `*` in that list expands to the write-target table's own columns, in declaration order; `TABLE.*` is not valid RETURNING syntax (SQLite rejects it), so no other wildcard form needs expanding.
The statement's `RETURNING` item text, evaluated as `select <items> from <target>`, is both the source `outputColumn` reads a `CAST` or `json_...` call from, and the source `Engine.affinities` probes for a computed expression's stored type — the same scratch-SELECT technique the rest of the module already uses for a real subquery, applied here because the DML statement itself cannot be that scratch SELECT.

`aliasMap` (`src/build/scan.ts`) is corrected as a prerequisite: its INSERT- and UPDATE-target parsing treated the token after the target table name as a possible table-valued-function call, the same way a FROM-list entry's next token is — so `INSERT INTO t (a, b) VALUES (...)` read `t`'s explicit column list as a call's argument list and discarded the table entirely, leaving no self-alias for a bare column in RETURNING to resolve against.
The column list is not a function call; `aliasMap`'s INSERT/UPDATE-target entry point no longer treats the token after the table name that way.
A related, cosmetic-only quirk in the same code — `INSERT INTO t VALUES (...)` (no explicit column list) reads the `VALUES` keyword itself as an implicit alias for `t` — resolved bare columns correctly by accident (the alias existed, only its name was wrong) and is fixed alongside it by adding `values` to the same stop-word set `indexed` and `not` (ADR referenced by the f21 ticket) already use, so the self-alias is named after the table, not the keyword that happened to follow it.

`refNullable`'s column lookup (`this.tables.get(table)?.columns.find((x) => x.name === ref.column)`) compares a reference's spelling to a declared column name by exact string equality.
RETURNING is the first reachable caller that can supply a reference whose case differs from the declaration (a SELECT's own callers have not exercised this in practice, per ADR history), so the same fix belongs here: the comparison switches to `sqliteName()`-based, matching how every other column lookup in this file already compares.

## Why

The rules a SELECT's items already have are correct for RETURNING's items too, because the alternative — a second, RETURNING-specific set of typing rules — would need to justify why a CAST or a JSON object means something different in one context than the other, and nothing does. The scratch SELECT is not a new mechanism; it is the same one `Engine.affinities` already uses for a real subquery, pointed at the one table RETURNING can reference instead of the DML statement it cannot wrap.

## Consequences

- A CAST already present in a RETURNING clause types on INSERT, UPDATE, and DELETE the same way it would in a SELECT; the "wrap it in cast(...)" error no longer fires when one already is.
- A JSON constructor (`json_object`, `json_group_array`, and so on) in a RETURNING clause types the same way it would in a SELECT's item list — not a separate, narrower capability.
- `aliasMap`'s two INSERT/UPDATE-target corrections apply to every caller of `aliasMap`, not only RETURNING typing; a caller relying on the previous (incorrect) behavior does not exist, since the previous behavior produced no working self-alias for these statement forms at all.
- `refNullable`'s case-insensitive column comparison applies to every caller, not only RETURNING; it can only ever remove an unnecessary `| null` this file previously added, never add one, since the previous behavior was to treat an unmatched case-spelling as "cannot tell, assume nullable."
- A RETURNING clause referencing a CTE is not valid SQLite syntax (`RETURNING` sees only the target table's columns); this decision does not need to account for one.
- A CAST around a bare NOT NULL column types nullable in RETURNING exactly as it does in a SELECT. Widening `castNeverNull` to recognize that shape is a separate decision affecting every caller, not part of this one.
- `Typer.analyze` has two callers: the build's own statement loop, and `solarsql analyze`'s catalog. A catalog entry, a query, and a command's `returns` all pass through `catalogStatement(sql, "read")`, which accepts only SELECT and VALUES. A command's plan item is the one caller that accepts a write, and the build refuses a plan item's RETURNING clause right after typing it, because the adapter discards its rows at run time.
- So a plan item with a computed RETURNING expression gets the correct "RETURNING clause is discarded" refusal from the build, in place of the "wrap it in cast(...)" error a CAST already satisfies. That refusal, not a typed row, is what a caller observes today.
