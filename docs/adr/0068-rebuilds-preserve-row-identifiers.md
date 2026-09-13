# ADR 0068: Rebuilds preserve accessible row identifiers

Status: accepted (2026-09-13)

## Context

The rebuild in ADR 0019 copies declared columns through a side table.
A table with a text primary key also has an implicit integer row identifier.
Copying only declared columns can change that identifier, even when the schema change concerns an unrelated constraint.

## Decision

When both table versions have row identifiers, preserve them during an automatic rebuild.
Capture an accessible identifier under a separate, collision-free column name in the side table.
Restore it through an accessible target identifier together with the declared columns.
A retained INTEGER PRIMARY KEY already carries the identifier, including an explicitly renamed key.
Use SQLite's primary-key index metadata to distinguish an INTEGER PRIMARY KEY alias from the inline DESC exception.

Block a rebuild when every identifier spelling is shadowed and no primary-key alias provides access.
Also block introducing a different primary-key alias: its stored values need not equal the existing row identifiers.
The diagnostic asks for an accessible identifier with the same alias, or an explicit migration with a data check.

Generated columns still compute their values in the target table.
The transaction, foreign-key restrictions, and final-name insertion order from ADRs 0019 and 0046 remain in force.
Transitions to or from WITHOUT ROWID explicitly change the schema's identifier model and copy declared columns.

## Evidence

Populated tests retain sparse row identifiers, declared values, shadow columns, generated columns, and renamed primary-key aliases.
Tests distinguish INTEGER PRIMARY KEY DESC and cover collisions with the side table's saved-identifier name.
Hegel varies row identifiers and text values across a constraint-changing rebuild.
Existing migration properties verify schema convergence and foreign-key data preservation.
