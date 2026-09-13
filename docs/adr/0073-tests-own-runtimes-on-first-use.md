# ADR 0073: Tests own runtimes on first use

Status: accepted (2026-09-13)

## Context

Node evaluates test registration code even for suites excluded by a name filter.
A D1 harness constructed during registration started Miniflare immediately.
The excluded suite's disposal hook did not run, so a successful selected test left the process running.

## Decision

Create the D1 harness runtime on first access.
Construction alone owns no runtime.
Dispose an existing runtime once, and make repeated disposal calls share the same promise.
Disposal before first use closes the harness without starting a runtime.
Later access to a disposed harness reports an error instead of silently creating another runtime.

## Evidence

The previously hanging focused migration test exits normally with its name filter.
A regression runs that exact selection in a child process with a 20-second failure deadline.
The deadline detects a hang; it does not force a successful exit.
Other tests verify disposal before and after use, repeated disposal, and rejected use after disposal.
The full test gate retains the existing local D1 behavior checks.
