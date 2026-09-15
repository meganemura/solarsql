# ADR 0110: A write plan item's RETURNING clause is refused

Status: accepted (2026-09-15). Records a refusal ADR 0100 already relies on.

## Context

Commit `04118d1` ("Refuse a write plan item whose RETURNING clause the run time discards") added this refusal to `src/build/build.ts`, before this record existed. A command's plan runs each statement through the adapter as a write, whose rows the adapter discards; a RETURNING clause on a write plan item would type correctly but its rows never reach the caller.

ADR 0100, accepted afterward, relies on this refusal as an established fact rather than deciding it: its Consequences state "the build refuses a plan item's RETURNING clause right after typing it, because the adapter discards its rows at run time," and "a plan item with a computed RETURNING expression gets the correct 'RETURNING clause is discarded' refusal from the build, in place of the 'wrap it in cast(...)' error a CAST already satisfies." This ADR is the record of that decision, written after the code and after ADR 0100 both already depended on it.

## Decision

A command plan item is refused when its SQL has a RETURNING clause and the item is not a read statement (a SELECT or VALUES item, which `returns` and catalog queries already are): `` A plan item's RETURNING clause is discarded at run time. Move the read into the command's `returns` field instead. ``

## Why

A command's plan items run as writes; the adapter that executes them discards whatever rows come back. A RETURNING clause on such an item would type successfully and then silently produce nothing the caller ever sees, so the refusal happens at build time instead of a caller discovering the empty result at run time.

## Consequences

- A plan item that needs a written row's values moves that read into the command's `returns` field, which does receive the statement's result.
- ADR 0100's own Consequences continue to hold unchanged: this refusal is the one they already described, now with its own record.
