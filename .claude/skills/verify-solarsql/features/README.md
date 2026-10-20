# solarsql verification map

This directory is the maintained source for verifying what a user of the `solarsql` command sees. Read this index before driving, then use the matching feature file as the recipe. `C` is `node .claude/skills/verify-solarsql/bin/control-solarsql.ts`, run from the checkout root (see `../SKILL.md`).

## Baseline preconditions

- Node satisfies `engines` in `package.json`, and `npm ci` has run in the checkout.
- `C launch` printed a workspace, and `C doctor <workspace>` exits 0.
- The project is empty (`package.json` only) unless a recipe says otherwise.

## Driving conventions

- Run every solarsql command through `C cli <workspace> -- <args>`, so the installed package runs and the transcript records it.
- Edit project files directly at the `project` path that `launch` printed.
- Take a snapshot before and after a command whose proof is on disk.
- A recipe that needs a project with a module starts with `C cli <workspace> -- init orders`.

## Proof and skip reporting

- CLI proof is the command, stdout, stderr, and exit code, from `evidence/transcript.jsonl`.
- File proof is the `changes.json` of the snapshot after the command.
- Record the feature ID and the sub-feature with every artifact.
- A sub-feature with a scenario is proven by `npx nuka run <feature>:<line>` and the summary copied with `npx nuka report --format markdown --out <workspace>/evidence/nuka-summary.md`.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a sub-feature as verified through another sub-feature's path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph on the user-visible behavior, then four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with control-solarsql`, `Gotchas`. Each sub-feature line ends with `Proven by` and the `<feature>:<line>` of the scenario that proves it, or `Proven by: no scenario`.

## Features

- [Start a project](./init.md): `init <module>`, `init --empty`, and the refusal on an existing config.
- [Build](./build.md): generated types, the pending-migration report, and `build --check`.
- [Write a migration](./migration.md): `migration <name>` after a schema change, and with nothing to migrate.
- [Run a query](./query.md): `query <module>.<catalog>.<name>` against a SQLite file.
