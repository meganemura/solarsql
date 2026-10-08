# ADR 0144: Worker and compiler import boundaries

Status: accepted (2026-10-04).

## Problem

The architecture check already declares 29 strict file modules, with 78 edges and no frozen violations.
The file boundaries distinguish shared SQL text, compiler responsibilities, execution contracts, and package adapters.
The adapter and runtime restrictions previously applied to value imports.
A simulated D1 import of the compiler's `Engine` type passed.
A simulated D1 value import of `node:perf_hooks` also passed the selected builtin restrictions.

## Usage

The existing callers keep their direct imports:

```ts
// The CLI requests a complete build.
import { build } from "./build.ts";

// A Worker adapter uses API types and the execution contract.
import type { Database } from "./index.ts";
import { bindValues } from "./runtime/plan.ts";

// The Node adapter uses the SQLite connection type.
import type { DatabaseSync } from "node:sqlite";
```

These examples belong to the CLI, a Worker adapter, and the Node adapter, respectively.
`npm run archstrict` checks their import boundaries.

## Shape

Keep the file modules and their public files.
`build()` hides configuration loading, schema preparation, ownership checks, type generation, and migration comparison behind one operation.
The adapters hide engine execution while `runtime/plan.ts` owns shared binding, assertion, and result rules.
`scan.ts` remains shared SQL text because compiler code, the Durable Object adapter, and the Node adapter use it.

Apply the adapter plane restriction to types and values.
Apply the runtime-to-build restriction to types and values.
Keep runtime-to-API type imports valid, and keep the compiler layer order restricted to value imports.
The latter checks execution direction; compiler type ownership can be evaluated separately.

Tag `index.ts`, `d1.ts`, `durable.ts`, `src/runtime/**`, and `scan.ts` as `host:worker`.
A point rule rejects their type and value imports of recognized Node builtins through `pkg:node`.
The Node adapter keeps its SQLite type dependency outside that host tag.
Compiler files keep their Node dependencies and the existing restrictions on filesystem and process access.

The point rule evaluates existing source edges even when those sources have no package imports.
An allow/deny rule for the same host would evaluate zero package edges in this graph.

## Synthesis decision

Retain file modules and add host ownership as a separate classification.
This preserves direct callers and strengthens two demonstrated gaps without changing production signatures or package exports.
Keep responsibility directories as a future option when a module needs several private files behind one stable operation.

## Tradeoffs and alternatives

- File modules expose named file contracts and require explicit declarations for new files.
  We accept that maintenance cost to keep independent compiler responsibilities visible.
- Responsibility directories can hide several implementations behind smaller public files.
  Adopting them now would require import changes and new public contracts for the existing compiler operations.
  A separate SQL text directory would avoid the earlier query-to-Node cycle.
  The proposed typing contract would still expose `Engine` and `Typer` separately to the orchestrator.
  The file rules already enforce privacy for `scope.ts`, `migration-files.ts`, and `failure.ts` through named callers.
- Moving shared SQL text into a compiler-only directory would require a separate contract for runtime migration parsing.
  The host tag expresses its deployment requirement without moving that contract.

## Verification and limits

The verified graph has 29 modules, 78 edges, and zero violations or todo entries.
Positive controls simulate adapter and runtime compiler-type imports, plus Node builtin imports from Worker and shared text code.
Each control checks the reported rule and configuration pointer without writing source files.
The controls run with the slow test project.

archstrict 0.1.0 leaves `node:sqlite` unresolved on Node 26.7.0.
The host rule therefore covers builtins that the analyzer recognizes; it cannot detect that SQLite import yet.
Windows checks remain disabled because this version reports false public-file bypasses there.
These tool limitations require analyzer fixes before either coverage claim can expand.

## Verified result

The whole-project simulation and architecture check passed.
All four positive controls passed.
The project typecheck, configuration typecheck, and 1,372 unit tests passed.
One unit test was skipped because its remote execution target was not configured.

Rechecked on 2026-10-09, with the later changes on main: the architecture check reports 29 modules, 80 edges, and no violations or todo entries, and the four positive controls pass. The CLI now imports `build.ts` with a dynamic import after the runtime check (ADR 0145, amendment of 2026-10-09), so the CLI line of the first example no longer matches `cli.ts`.
