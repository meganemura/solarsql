# Write a migration

`solarsql migration <name>` writes `migrations/NNNN_<name>.sql` with the difference between the migration files applied in order and the declared schema, and rewrites `migrations/index.ts`. With no difference it writes nothing.

## Sub-features

- `migration-write` writes the next numbered file with the statement the build reported, and the next build says `migrations are current`. Proven by `features/start-change-migrate.feature:8`.
- `migration-nothing` prints `nothing to migrate`, exits 0, and writes no file. Proven by: no scenario.
- `migration-intent` takes a rename declaration through `--intent changes.json`. Proven by: no scenario.

## How to get to it (user POV)

- `npx solarsql migration <name>` after `build` says a migration is pending.

## Driving it with control-solarsql

Preconditions:

- A workspace after the `Build` recipe, with `migration pending` reported.

- **Write.** Run `C cli <workspace> -- migration add_note`. Exit code `0`; stdout says `wrote migrations/0002_add_note.sql` and prints the statement.
- **Files.** Run `C snapshot <workspace> after-migration`. `added` lists `migrations/0002_add_note.sql`, and `changed` lists `migrations/index.ts`.
- **Current.** Run `C cli <workspace> -- build --check`. Exit code `0`, and stdout says `migrations are current`.
- **Nothing.** Run `C cli <workspace> -- migration again`, then `C snapshot <workspace> after-nothing`. Exit code `0`, stdout says `nothing to migrate`, and the snapshot lists no change.

## Gotchas

- The number comes from the files on disk. Read it from the `wrote` line rather than assuming `0002`.
- `migration` runs every check `build` runs first, so a module-boundary violation stops it before a file is written.
