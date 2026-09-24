# ADOPTION_PAIN — solarsql (rocky local dogfood)

Date: 2026-09-24

## Setup
- Worktree: `solarsql-archstrict-adopt` from `origin/main`
- Install: `file:../archstrict` (local unpublished)

## Frictions

### 1. Whole-tree analysis without seeded excludes (archstrict-4fq)
`init 'src/*'` then `check` reported **128 uncovered-module** from `example/`, `spike/`, `test/`, plus loose src files.
Expected: init seeds common excludes or screams louder with a paste-ready exclude block.

### 2. `src/*` only discovers directories (archstrict-lh9)
Loose `src/index.ts`, `src/d1.ts`, `src/durable.ts`, `src/node.ts` were uncovered. init declared only `build` and `runtime`.

### 3. Single-file modules break `todo` (archstrict-4oe) — P0
Declaring `{ glob: "src/index.ts", ... }` made `todo` try to open `src/index.ts/archstrict.todo.json` → **ENOTDIR**.
`do:` text also assumed a directory (`add a index.ts to src-index/`).

### 4. Hand-edited `declaredModules` vs regenerated types (related archstrict-re9)
After hand-adding modules, re-running `init` left config untouched (good) but regenerated `ModuleName` from the glob walk only (`"build" | "runtime"`), dropping hand-added names. `satisfies Config` then lies until types are patched by hand.

### 5. Install story for unpublished package (archstrict-aic)
Had to choose `file:` vs `github:` vs reserved npm `0.0.0`. Docs should say which mode for dogfood.

## What made it operational
- `exclude`: test/example/spike/dist/coverage/scripts/features + root `*.ts`
- Single module `{ name: "solarsql", glob: "src/**", surface: "index.ts" }` for first adopt
- `check` exit 0; `todo` firstRun with 0 freezable debt

## Notes for triage
Refining into build/runtime boundaries is desirable later, but blocked on safe single-file / multi-entry story and better init for library layouts.
