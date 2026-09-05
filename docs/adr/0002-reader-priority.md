# ADR 0002: The first reader is a coding agent

Status: accepted (2026-09-06)

## Context

Code written for solarsql is read and written by coding agents first, and by humans second.
An agent starts from an empty context and reads a bounded number of files.

## Decision

Every design question is judged by one test: can an agent read this from an empty context and write correct code?

Four properties serve that reader:

1. One noun has its verbs in one place.
2. Inputs and outputs are written as types.
3. Nothing runs that the calling line does not show.
4. The receiver of a value sees no hidden state on it.

## Why

An agent is harmed by code that runs in a file it has not read.
The four properties keep the relevant code in the files the agent has open.

## Consequences

- Rows carry no methods and no callbacks (ADR 0007).
- Commands are data that the agent can read as a list (ADR 0006).
- Types are generated from the engine and fail loudly when stale (ADR 0010).
