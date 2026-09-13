# ADR 0044: Build errors name the statement location

Status: accepted (2026-09-13). Extends [ADR 0005](0005-query-catalog.md) and [ADR 0033](0033-one-source-file-per-module.md).

## Context

A SQL fragment identifies the failing statement, but an agent must still find the catalog entry to edit.
Several queries or commands can share the same SQL text and its generated type entry.
The imported module exposes catalog names and plan positions that can identify each use.

## Decision

Statement diagnostics retain the existing error and SQL, and add the module's actual `module.ts` path.
This applies to query and command SQL analysis, their boundary checks, and command validation.
Schema and import diagnostics keep their existing context.
Each location names the exported catalog and its entry.
A command location also names the plan position, counted from 1, and the assert name when applicable, or `returns`.
Shared SQL reports all its catalog locations.

Locations come from the imported exports and plans.
They do not contain estimated line numbers.

## Why

The path and catalog entry give an agent a concrete edit target without a search for matching SQL.
All uses of shared SQL help the agent assess the effect of an edit.
Catalog locations use the module structure already available to the build.

## Consequences

Statement analysis still shares work by SQL text.
Diagnostic locations preserve each use separately from that shared analysis.
The SQL and engine message remain available for diagnosis.
