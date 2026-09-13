# ADR 0082: Unknown errors retain their identity

Status: accepted (2026-09-13)

## Context

JavaScript can throw any value, including null and undefined.
Constraint classification previously accessed message fields before checking their shape.
An unexpected thrown value could therefore become a new TypeError, hiding the original failure.

## Decision

Read error details defensively and classify only usable message text.
Decline classification for unsupported values or inaccessible fields.
Preserve the adapter's original thrown value when classification fails.
Keep engine message and cause handling, and retain aggregate cleanup failures as thrown errors.

## Evidence

A property test covers primitive values, malformed message fields, inaccessible properties, and aggregate errors.
Public D1 and Durable command paths rethrow unrecognized values unchanged.
Existing engine-message properties retain ordinary constraint and assertion results.
