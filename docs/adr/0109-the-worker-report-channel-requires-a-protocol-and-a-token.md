# ADR 0109: The worker report channel requires a protocol and a token

Status: accepted (2026-09-15). Adds a message filter in front of ADR 0062's report count.

## Context

Commit `91dbd01` ("Require a protocol and token on a worker's report message") changed `src/build/machine.ts`, before this record existed. ADR 0062 routes `inspect` and `build --json`'s report through Node IPC and its Boundary section states plainly that application imports retain their permissions and side effects inside that same child process; the channel carries whatever the child sends, and ADR 0062's collection mechanism pushed every message the child sent onto `reports`, counting all of them toward its own required-one-report rule. Its own added comment names the consequence: "an unrelated `process.send()` call from imported project code must not be able to inflate `reports.length` and turn a successful build into a reported failure."

## Decision

The parent generates a random token (`randomUUID()`) for each worker run and passes it to the child through an environment variable the child deletes from its own `process.env` immediately, the same way it already does for the channel marker. Every report the child sends carries a shared protocol string and that token. The parent's message handler pushes a message onto `reports` only when its protocol and token both match; every other message on the channel is ignored.

## Why

ADR 0062's required-one-report rule only works if `reports` holds exactly the messages the parent's own child actually meant as its report. A per-run random token makes that message unforgeable by anything that does not already have it, so the count that rule relies on reflects only genuine reports.

## Consequences

- An unrelated `process.send()` call from imported application code no longer inflates `reports.length`; a successful build stays successful even if application code sends other IPC messages.
- ADR 0062's own required-one-report rule, and its `BUILD_WORKER_FAILED` diagnostic, are otherwise unchanged; this adds a filter in front of the count, not a new rule on top of it. ADR 0062 is not edited.
