# ADR 0128: The generated file imports id types through public.ts

Status: accepted (2026-09-20). Amends ADR 0025.

## Context

A module-boundary checker run over example/ found three imports that bypass the public surface: `orders/solarsql.generated.ts` imported `CustomersId` from `../customers/solarsql.generated.ts`, and `reports/solarsql.generated.ts` imported `CustomersId` and `OrdersId` the same way.
SKILL.md's own rule says a file of a module imports another module only through that module's `public.ts`.
ADR 0025 carved the generated file out of that rule: "It imports the id types it uses from the generated files of other modules."
A type-only import counts as a boundary crossing for the checker, and all three types were already exported by their owners' `public.ts`.

## Decision

The generated file imports a used id type from the owner module's `public.ts`, not its generated file.
Before it writes the importing module's generated file, the build confirms the owner's `public.ts` exports each id type the import needs: an identifier inside an `export type { ... }` or `export { ... }` list, or the name of an `export type <Name> = ...` declaration.
A miss refuses the build with `module <importer> uses <Type> of module <owner>, and <owner>/public.ts does not export it. Add: export type { <Type> } from "./solarsql.generated.ts";`.
`init`'s `publicTemplate` already exports a module's own id type, so a project started with `solarsql init` never hits this.

## Consequences

- ADR 0025's exception for the generated file is gone: every file of a module, generated or hand-written, imports another module only through its `public.ts`.
- A module whose `public.ts` drops an id type another module uses fails the build with the message above, the boundary working as intended.
- The check is a regex over `public.ts`'s text, not a TypeScript parse: `public.ts` is a short, hand-written file, and the build already reads other modules' source files as text for the cross-module write check.
