# ADR 0021: SQL is a plain string literal

Status: accepted (2026-09-06). Supersedes the tagged-template part of ADR 0004.

## Context

ADR 0010 keys the generated types by the SQL text, so a changed text fails `tsc`.
ADR 0004 wrote the SQL inside a tagged template.
TypeScript 7.0.2 gives a tagged template the type `TemplateStringsArray`, with no literal type for the text.
A plain string literal gets its literal type through a `const` type parameter.

## Decision

Schema, queries, asserts, and plan statements are plain string literals.
Parameters are named, `:name`.
Documentation is the leading `--` comment lines of the string.

## Why

The literal type is what makes a stale type fail to compile.
A tagged template cannot provide it, so a plain literal is the only form that works.
A named parameter is readable and reusable across the statements of a plan.
A comment inside the string keeps the documentation next to the SQL, with no second place to write it.

## Evidence (v1)

`spike/tagged/tagged.ts` fails `tsc` on the tagged template and passes on the plain literal.
A query whose text changed fails with `TS2820: Type '"select ..."' is not assignable to type '...'. Did you mean '"..."'?` at the call site (`test/stale.test.ts`).
See v1-measurements.md, section 1.

## Consequences

- `${...}` interpolation is gone. Dynamic SQL is out of the typed surface.
- The generated map is keyed by the exact text, including the comment and the whitespace.
