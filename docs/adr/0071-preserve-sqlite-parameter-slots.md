# ADR 0071: Preserve SQLite named-parameter slots

Status: accepted (2026-09-13)

## Context

SQLite assigns different slots to `:id` and `@id`.
Removing both prefixes collapsed those slots into one generated parameter and caused a Node binding failure.
The scanner also inferred parameter types only for the colon prefix.

## Decision

Keep each full SQLite parameter name in first-appearance order, with repeated names sharing one slot.
Use the bare name as the generated key when it is unambiguous.
For colliding keys, retain the prefix until every generated key is distinct.
This also handles a bare name that starts with a dollar sign and collides with an already qualified key.

Apply the same slot mapping to type inference, JSON encoding metadata, and runtime binding order.
Infer colon, at-sign, and dollar parameters through the same SQL shapes.
Keep digit names, Unicode names, namespace separators, and parenthesized suffixes within one parameter token.
The engine still prepares each statement before accepting its contract.

The Node adapter binds full names with bare-name lookup disabled.
D1 and Durable Objects receive positional values in the generated slot order.
SQL text remains unchanged.
Missing-parameter and type-conflict diagnostics quote the exact generated key.

## Evidence

A generated caller distinguishes numeric `:id` from textual `@id` and compiles with the expected keys.
That caller returns the same rows on Node, local D1, and a local Durable Object.
Hegel varies parameter order, repeated references, prefixes, and values against direct SQLite binding.
Scanner tests cover qualified-key collisions and additional SQLite name forms.

## Boundary

Generated keys belong to each statement contract.
Adding a colliding name changes the affected keys and therefore requires caller changes.
Anonymous and numbered question-mark parameters retain their existing build rejection.
The token rules follow the [SQLite tokenizer](https://github.com/sqlite/sqlite/blob/master/src/tokenize.c).
