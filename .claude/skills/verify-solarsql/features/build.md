# Build

`solarsql build` reads each module's DDL and SQL strings, types them against the real engine, writes `solarsql.generated.ts`, and reports whether a migration is pending. `build --check` writes nothing and exits 1 when a generated file, `migrations/index.ts`, or a migration is behind the source.

## Sub-features

- `build-types` writes the generated file, and a new nullable column is `string | null` in the query's row type. Proven by `features/start-change-migrate.feature:8`.
- `build-pending` exits 0 on a schema change with no migration yet, prints the statement, and names `npx solarsql migration <name>`. Proven by `features/start-change-migrate.feature:8`.
- `build-check-stale` exits 1 on an edit the build has not seen, writes no file, and names `npx solarsql build`. Proven by `features/check-before-build.feature:8`.
- `build-check-pending` exits 1 after the build while a migration is still pending. Proven by: no scenario.
- `build-current` exits 0 with `migrations are current` once the migration exists. Proven by `features/start-change-migrate.feature:8`.
- `build-json` prints the generation result as JSON. Proven by: no scenario.

## How to get to it (user POV)

- `npx solarsql build [solarsql.config.ts]` after an edit to a module.
- `npx solarsql build --check` in CI, a test hook, or `prepublishOnly`.
- `npx solarsql build --json`, alone or with `--check`.

## Driving it with control-solarsql

Preconditions:

- A workspace after `C cli <workspace> -- init orders`.

- **Edit.** In `modules/orders/module.ts`, add `note text` as the last column of `orders` and `note` to the `all` query's select list.
- **Before.** Run `C snapshot <workspace> edited`.
- **Stale check.** Run `C cli <workspace> -- build --check`. Exit code `1`; stdout marks the generated file `stale` and names `npx solarsql build`.
- **Nothing written.** Run `C snapshot <workspace> after-check`. `added`, `changed`, and `removed` are all empty.
- **Build.** Run `C cli <workspace> -- build`. Exit code `0`; stdout has `wrote` for the generated file, `migration pending`, and `alter table main."orders" add column note text`.
- **Types.** In `modules/orders/solarsql.generated.ts`, the entry for the `all` query's SQL has `note: string | null` in its `row`.
- **Pending check.** Run `C cli <workspace> -- build --check`. Exit code `1`, and stdout still says `migration pending`.
- **Proof.** Run `C snapshot <workspace> after-build`. `changed` lists `modules/orders/solarsql.generated.ts` only.

## Gotchas

- A pending migration is not a build failure: `build` exits 0 and writes the types. Only `--check` turns it into exit 1.
- The generated file's keys are the SQL text, so a query edit renames its entry; search for the new SQL, not the old.
- Paths in `build` output are absolute. Compare a suffix, not the whole line.
