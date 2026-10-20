# Start a project

`solarsql init` starts a project in an empty directory: a config, one module with a placeholder table, its test, the generated types, and the first migration. `init --empty` writes the config with no module. Both refuse a directory that already has a config.

## Sub-features

- `init-module` writes the config, `modules/<module>/`, `tsconfig.json`, the generated file, and `migrations/0001_initial.sql`, and the module's own test passes. Proven by `features/start-change-migrate.feature:8`.
- `init-empty` writes the config with `modules: []`, `tsconfig.json`, and an empty `migrations/index.ts`. Proven by: no scenario.
- `init-refuses` exits 1 when `solarsql.config.ts` exists. Proven by: no scenario.

## How to get to it (user POV)

- `npx solarsql init <module> [dir]` in a project with solarsql installed.
- `npx solarsql init --empty [dir]`.

## Driving it with control-solarsql

Preconditions:

- A fresh workspace from `C launch`, and `C doctor <workspace>` exits 0.

- **Before.** Run `C snapshot <workspace> empty`. `added` lists `package.json` and `package-lock.json` only.
- **Start.** Run `C cli <workspace> -- init orders`. Exit code `0`, and stdout has a `wrote` line for `solarsql.config.ts`, `modules/orders/module.ts`, `modules/orders/public.ts`, `modules/orders/module.test.ts`, `tsconfig.json`, `modules/orders/solarsql.generated.ts`, `migrations/index.ts`, and `migrations/0001_initial.sql`, then `next` lines.
- **Files.** Run `C snapshot <workspace> after-init`. `added` lists the same eight files.
- **Module test.** In the project directory, run `node --test`. Exit code `0`, one test passed.
- **Refusal.** Run `C cli <workspace> -- init orders` again. Exit code `1`, and stderr says `solarsql.config.ts exists`.
- **Empty.** In a second fresh workspace, run `C cli <workspace2> -- init --empty`. Exit code `0`; the config's `modules` is `[]` and no `modules/` directory exists.

## Gotchas

- The module name must match `[a-z][a-z0-9_]*`; it becomes the table name and the directory name as typed.
- `init` builds, so a Node outside the engines range fails here first. Its message is on stderr; nukadoko's progress line shows only the first line of a step's error, so read `run.json` or the step record for the rest.
- `node --test` run from inside another test runner inherits `NODE_TEST_CONTEXT` and reports to that runner instead of stdout. Unset it.
