# ADR 0086: Assert results have invocation identities

Status: accepted (2026-09-14)

## Context

SQLite reports a trigger abort through its message and constraint code.
The adapter previously matched that message directly against the command's public assert names.
A user trigger with the same message was therefore reported as a failed solarsql assert, even when the guard statement did not run.

## Decision

Give each command invocation a random guard token.
Put the token, an internal prefix, and the public assert name in the guard row.
Classify a trigger abort only when its complete message contains the token for that invocation.
Return only the public assert name in `CommandResult`.
Rethrow user trigger errors unchanged when their messages match a public name or resemble the internal prefix.

## Evidence

A property varies valid public names, invocation tokens, and engine message wrappers.
Only the identity for the current invocation becomes an assert result.
A public command meets same-name and prefix-like user triggers on Node, local D1, and a Durable Object.
Each adapter rethrows those errors and retains zero inserted rows.
Existing command tests retain genuine assert results and transaction rollback.
