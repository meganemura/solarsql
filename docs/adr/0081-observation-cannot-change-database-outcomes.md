# ADR 0081: Observation cannot change database outcomes

Status: accepted (2026-09-13)

## Context

An observer runs after a database operation has produced its result.
A thrown observer error previously replaced a successful command result, even after the write committed.
The error path then called the observer again.
A caller could interpret that logger failure as a failed write and repeat the command.

## Decision

Notify the observer once with the database outcome.
Preserve the operation's result or original thrown value.
Contain synchronous observer exceptions and rejected observer promises.
Do not await a promise returned by the observer.
The observer owns telemetry delivery and reports its own failures when required.
Database transactions and command retry policy remain unchanged.

## Evidence

A property test varies operation outcomes and synchronous, rejected, pending, and successful observer behavior.
It checks result identity, error identity, and one notification.
A public Node command remains successful and committed when logging throws; a duplicate remains a constraint result.
D1 and Durable adapter reads also retain their results when asynchronous observation fails.
