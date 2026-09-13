# ADR 0088: Runtime parameters match the operation contract

Status: accepted (2026-09-14)

## Context

TypeScript checks object literals for extra fields, but a variable can carry stale or misspelled keys.
The adapters silently ignored those keys.
They also accepted a required parameter from an object's prototype.
A Durable Object batch could execute earlier reads before a later read exposed a missing key.

## Decision

Validate the complete parameter contract for each public operation before SQL executes.
Require each generated key as an own property with a defined value.
Reject extra own enumerable string keys.
Report missing and extra keys in sorted order, including their SQLite prefixes.
Validate every read in a batch before the first read executes.
Validate a command against the union of its plan, asserts, and `returns`, then bind each statement in its generated order.

## Evidence

A property varies prefixed key sets, statement partitions, own fields, prototype fields, and extra fields.
It compares each diagnostic with the complete sorted difference.
A command uses disjoint parameters in two statements, an assert, and `returns` on Node, local D1, and a Durable Object.
Each target accepts the complete object and rejects extra, inherited, batch, and command mismatches before an invalid write.
Existing adapter tests retain JSON encoding, null values, parameter order, and calls without parameters.
