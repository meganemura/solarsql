# ADR 0014: The inner loop is synchronous and in-process

Status: accepted (2026-09-06)

## Context

An agent runs the build many times per task.
A loop that starts a runtime or a container is too slow for that.
node:sqlite and D1 run the same engine.

## Decision

The user's inner loop is one command: `tsc`, the build checks, and unit tests on node:sqlite.
Everything in it is synchronous and completes in seconds.
Miniflare runs in the CI of the library and as an opt-in for users.
The tests of the library itself are property-based with Hegel where a property exists.

## Why

The meaning of SQL can be checked on the fast engine because it is the same engine.
The meaning and the limits of a D1 batch are the responsibility of the library, so the library proves them in its own CI.

## Evidence (v0)

node:sqlite 26.7.0 and workerd 1.20260828.1 both carry SQLite 3.53.4.
The full v0 suite of 17 tests, including three Miniflare suites, runs in about 1.5 seconds.
See v0-measurements.md, sections 1 and 4.

## Consequences

- The library CI prints both SQLite versions, so a drift between them is visible.
- Users get property-based testing helpers after version 1.
