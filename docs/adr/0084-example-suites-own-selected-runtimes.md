# ADR 0084: Example suites own selected runtimes

Status: accepted (2026-09-13)

## Context

Example suites created their Worker runtimes during test registration.
A name filter could exclude every test while those runtimes kept the process alive.
The ownership rule in ADR 0073 also applies to these direct Worker fixtures.

## Decision

Create one runtime per selected backend in its suite setup hook.
Keep its disposal hook registered before setup executes.
The hook disposes the owned runtime even when migration setup fails.
An excluded suite owns no runtime.

## Evidence

A child process selects an unmatched test name and must exit successfully within 20 seconds.
The deadline detects a leak; it does not force a successful exit.
The full example suite still runs each step against isolated D1 and Durable Object runtimes.
