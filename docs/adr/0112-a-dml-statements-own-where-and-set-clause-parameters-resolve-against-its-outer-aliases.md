# ADR 0112: A DML statement's own WHERE and SET clause parameters resolve against its outer aliases

Status: accepted (2026-09-15)

## Context

ADR 0051's Decision scoped its own fix deliberately: "Type inference finds the enclosing SELECT scopes and resolves local aliases before correlated outer aliases," and its closing line states the boundary directly: "This change handles table references in SELECT scopes. CTE output parameters and some unqualified nested references retain the SqlValue fallback."

An UPDATE or DELETE statement's own top-level WHERE clause, and an UPDATE's own SET clause, are not inside any SELECT scope: `Typer.parameterScopes` (`src/build/typegen.ts`) only ever finds an *enclosing* SELECT token before a parameter's offset, and a DML statement's own top-level clauses have none. A parameter site there left `Typer.paramType`'s `context` undefined, which fell through to `aliasOfBareColumn` against the whole-statement-text alias map `analyze()` computes once (`aliasMap(sql)`, unscoped) — the exact statement-wide map ADR 0051's own Context names as the defect it fixed for SELECT-scoped sites: "A statement-wide alias map assigns both parameter sites to one table and can emit an incorrect parameter type."

This produced a real defect: `update orders set note = (select l.sku from order_lines l where l.order_id = orders.id limit 1) where id = :id` typed `:id` as `SqlValue` instead of its primary-key brand, whenever `order_lines` (aliased `l` in the SET clause's own nested subquery) happened to declare a column also named `id`. `aliasOfBareColumn` saw two candidate owners of `id` — the statement's own target, `orders`, and the nested subquery's own alias, `l` — and returned null (ambiguous). The same collapse reproduced for a WHERE-clause `EXISTS` subquery, and for an `in_json` parameter site (`id in (select value from json_each(:ids))`), where it additionally dropped the parameter's array wrapper and its `encode: true` flag. No RETURNING clause, and no join, is needed to reproduce any of these; the defect predates ADR 0100 and sits in a different code path (`paramType`) from the one ADR 0100 and ADR 0111 govern (`returningColumns`/`outputColumn`).

## Decision

A parameter site with no enclosing SELECT scope (`context === undefined` in `paramType`'s `ofRef`) resolves a bare column reference against the statement's own outer aliases only — the same `aliasMap(sql, true)` (`outerOnly`) map `returningColumns` already computes for RETURNING's own resolution — not against the whole-statement-text map that also carries a nested subquery's own aliases.

A parameter site whose `context` is set, but whose `scopedReference` lookup fails to resolve it (a parameter genuinely inside a nested SELECT subquery's own scope, DML or not), is unchanged: it still falls back to the whole-statement map. ADR 0051's own stated remaining gap — "CTE output parameters and some unqualified nested references retain the SqlValue fallback" — still applies to that path; this decision narrows it, for the DML top-level case specifically, without closing it everywhere.

## Why

The reasoning is the same reasoning ADR 0051 already gave for a SELECT's own parameter sites: a statement-wide alias map conflates a reference's own scope with every other scope the statement happens to contain, and an unrelated nested subquery's alias should never make an otherwise-unambiguous outer reference look ambiguous. ADR 0051's fix reached SELECT scopes because that was what its own evidence covered; a DML statement's own top-level clauses are the same shape of problem, just outside a SELECT, and nothing about the reasoning depends on the statement kind.

## Consequences

- `update orders set note = (select l.sku from order_lines l where l.order_id = orders.id limit 1) where id = :id`, `delete from orders where id = :id and exists (select 1 from order_lines l where l.order_id = orders.id)`, and the equivalent `in_json` shape all now type their WHERE-clause parameter correctly, matching the no-collision baseline.
- A parameter genuinely inside a nested subquery's own scope (for example `... from order_lines l where l.order_id = orders.id and l.sku = :sku`) is unaffected: it resolves through `scopedReference` before any fallback is reached, exactly as before.
- ADR 0051's own named remaining gap ("some unqualified nested references retain the SqlValue fallback") is narrower after this decision but not eliminated: a parameter whose `context` is set and whose `scopedReference` lookup fails still falls back to the unscoped map.
- This is a different code path from ADR 0100 and ADR 0111, which govern RETURNING's own output-column resolution (`returningColumns`/`outputColumn`); this decision affects `paramType` only, and does not change how any RETURNING output column types.
