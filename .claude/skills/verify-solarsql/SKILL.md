---
name: verify-solarsql
description: Drive the solarsql CLI (init, build, build --check, migration, query) the way a user does, from this checkout's packed tarball installed in a project of its own, and capture proof. Use to prove a change to the CLI or the build works end to end, to reproduce a reported CLI behavior, or before a release.
---

# Verify solarsql

solarsql's user surface is the `solarsql` command a project runs through `npx`, plus the files it writes. The other surfaces (the library API in a Worker, the Durable Object adapter) are covered by `npm run test:all`, not by this skill.

One **workspace** is the instance this skill drives: a directory that holds this checkout's tarball, a project with that tarball installed, and an `evidence/` directory. It lives across many calls, so an agent can run a command, edit a file, and run the next command against the same state. `bin/control-solarsql.ts` is the control CLI. Every command takes the workspace path that `launch` printed.

The control CLI and the nukadoko steps share `features/steps/lib/workspace.ts`. An operation tried here by hand is the same function a scenario runs. The library sits with the steps so that the acceptance scenarios do not depend on this skill's directory. The feature map in [features/](features/README.md) links each sub-feature to the scenario that proves it.

Below, `C` stands for `node .claude/skills/verify-solarsql/bin/control-solarsql.ts`, run from the checkout root.

## Launch

Node must satisfy `engines` in `package.json` (`^24.20.0 || >=26.7.0`). solarsql refuses any other Node at startup, and so does every step that runs the CLI.

```sh
npm ci
C launch [--root <dir>]
```

`launch` runs `npm pack` (which builds `dist/` through `prepack`), creates `<root>/verify-solarsql-XXXXXX/` (default root: the OS temp directory), installs the tarball into `app/` there, and prints JSON with `workspace`, `project`, `evidence`, `commit`, and `version`. It is ready when it exits 0 and `doctor` passes. A project starts empty: `init` is the first drive, not part of launch.

Workspaces are independent. Two runs can each launch their own and drive them side by side.

## Doctor

```sh
C doctor <workspace>
```

Read-only. Exit 0 and `"ok": true` when all four checks pass:

- `installed`: `node_modules/solarsql` is the version that was packed.
- `bin-starts`: `solarsql --version` exits 0 under the current Node. This is the check that catches a Node outside the engines range.
- `same-node`: the current Node is the one the workspace was packed under.
- `checkout-unchanged`: `src/`, `package.json`, `skills/`, and `llms.txt` are as they were at launch, uncommitted edits included. When this fails, the workspace runs old code: launch a new one.

Run it before the first drive, after any surprising result, and after editing the checkout.

## Drive

```sh
C cli <workspace> -- <solarsql args...>
```

Runs the installed bin in the project directory, prints its stdout and stderr, exits with its exit code, and appends `{ at, argv, cwd, exit_code, stdout, stderr }` to `evidence/transcript.jsonl`. Edit the project's files directly (the project path is in `launch`'s output) between commands, as a user would.

```sh
C database <workspace> <file.sqlite>
```

Scaffolding for `query`: creates the file in the project with every `migrations/*.sql` applied in order. solarsql itself applies no migration (wrangler applies them to D1), so this stands in for that step. It refuses a file that exists.

A scenario step runs against the same workspace, because its handle is a path:

```sh
npx nuka do <step> --args '{"project":"<project>"}'
npx nuka do <next step> --use <step record id>
```

`nuka do` runs the step under its contract and prints a step record with the processes it ran. `--use` fills the next step's `from` keys from that record, so a scenario's When and Then can run one at a time on a workspace an agent has already driven by hand. For example, after `C cli <workspace> -- init orders`: `add-note-column` with `{"project":"<project>","module":"modules/orders"}`, then `run-build-check` with `{"project":"<project>"}`, then `assert-check-refused --use <run-build-check's record id>`.

The feature files give the exact commands per feature.

## Evidence

```sh
C snapshot <workspace> <label>
```

Copies the project's files (no `node_modules`) to `evidence/snapshots/NN-<label>/files/`, with `manifest.json` (content hashes) and `changes.json` (`added`, `changed`, `removed` against the previous snapshot). Take one before and one after a command whose proof is a file it wrote or did not write.

Proof standards:

- Drive the installed package through `cli`. Never run `src/build/cli.ts` from the checkout for a proof: the tarball's `files` list is part of what a user gets.
- A command's proof is its exit code, its output from the transcript, and its effect on disk from a snapshot. Output alone does not prove a file was written, or that none was.
- Take expected values from `skills/solarsql/references/` and the README, not from what the command printed this time. A value with no written source is a question for the owner.
- For a sub-feature the map links to a scenario, the scenario's run is the repeatable proof: `npx nuka run <feature>:<line>`, then `npx nuka report --format markdown --out <workspace>/evidence/nuka-summary.md`. nukadoko keeps only the newest runs, so the copy in `evidence/` is the one to cite.

## Cleanup

```sh
C cleanup <workspace>
```

Removes `app/` and `pack/` and keeps `evidence/` and the marker file. Every command but `launch` refuses a directory without `verify-solarsql.json`, so a path that this skill did not create is never driven or removed. Delete the evidence directory by hand when nobody needs it.

## Helpers

- `bin/control-solarsql.ts`: the control CLI. Executable; `C` with no arguments prints its usage.
- `features/steps/lib/workspace.ts`: `packCheckout`, `createProject`, `runSolarsql`, `installedVersion`, `checkoutFingerprint`, `projectFiles`, `changedFiles`, `applyMigrations`. Processes go through nukadoko's `runCommand`, imported directly: a step that calls them lists each process in its step record, and a call from the control CLI runs the same way, unrecorded. No runner is passed in.
