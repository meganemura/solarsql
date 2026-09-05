# ADR 0024: The package ships the source and the compiled output

Status: accepted (2026-09-06)

## Context

An agent reads the library it uses.
TypeScript source is what it reads best.
Node strips types from `.ts` files, but refuses to do so under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, Node 26.7.0).
The CLI and the adapters must run from `node_modules` in a user project.

## Decision

The package contains `src/` and `dist/`.
`dist/` holds the JavaScript, the declarations, the declaration maps, and the source maps that `tsc` emits from `src/`.
`exports` and `bin` point at `dist/`.
The declaration maps point back at `src/`, so an editor and an agent land in the source.

## Why

A source-only package does not run.
A dist-only package hides the source from the agent.
Both together cost nothing at run time.

## Evidence (v1)

A source-only package fails at the bin and at the import from `node_modules`.
The packed package installs into a fresh project, its CLI builds the example, and its adapters import (`test/pack.test.ts`).
See v1-measurements.md, section 4.

## Consequences

- `npm run build` runs `tsc -p tsconfig.build.json`, and `prepack` runs it.
- The repository's own tests import `src/` directly, so the inner loop needs no emit.
