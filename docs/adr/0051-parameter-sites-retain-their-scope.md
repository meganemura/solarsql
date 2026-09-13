# ADR 0051: Parameter sites retain their scope

Status: accepted (2026-09-13). Extends parameter inference in ADR 0010.

## Context

An inner SELECT can reuse an outer SELECT's table alias.
A statement-wide alias map assigns both parameter sites to one table and can emit an incorrect parameter type.
UNION branches can reuse aliases in the same way.

## Decision

The scanner optionally records the source offset of each parameter site.
Type inference finds the enclosing SELECT scopes and resolves local aliases before correlated outer aliases.
Each compound branch has its own aliases.
A parameter used against incompatible column types still produces an error.
An unresolved CTE binding must not acquire the type of a stored table with the same name.

This change handles table references in SELECT scopes.
CTE output parameters and some unqualified nested references retain the SqlValue fallback.

## Evidence

Tests cover alias shadowing, independent UNION branches, correlated outer references, incompatible shared parameters, and a CTE that shadows a table.
Existing JSON bulk-write tests retain their parameter contracts.
