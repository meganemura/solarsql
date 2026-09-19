# ADR 0125: The CLI prints the rule instead of naming the reference

Status: accepted (2026-09-19)

## Context

A workflow walk over five scenarios (invalid SQL, a stale generated file, a DDL-only change, a cross-module write, a rename that needs an intent) counted about eight reference reads for rules the build's own output already prints; a separate experiment measured fresh agents on solarsql at roughly 1.5x the tool calls of agents on a plain query builder for the same outcome, and the walk's eight reference reads are the suspected mechanism. `SKILL.md` sent the agent to a reference "before you edit" on every step, even when the command it was about to run would print the rule itself.

## Decision

A rule an agent needs at one step is printed by the command that ends that step, not looked up first. `SKILL.md`'s workflow now says: run the command the last line names; open a reference only when a message names one, or when the rule is not in `SKILL.md` itself. The reference stays the master for the full rule; `SKILL.md` and the CLI carry only the part an agent needs at that step.

This moves work onto the CLI's own output: `build` reports every failing statement in one run, each under `in:` with its `at:` line, instead of stopping at the first, and a `no such column` failure lists `columns of <table>: ...`. `build`'s and `migration`'s last line, `next: <command>`, names the next command in every case: `npx tsc --noEmit && npm test` after a clean build with migrations current, the migration command when one is pending, or a fix line for a blocked migration. `migration <name>` prints `wrote <relative path>` and the statements it wrote before that line. The cross-module write error names the owner's `module.ts` and its commands catalog, so the fix does not need a lookup to find where the write belongs.

## Consequences

- The build's last line and its error lines are part of the contract: `test/docs.test.ts` pins every message fragment `build.md`'s table quotes against the source of `src/build`, so a wording change without a matching doc change fails the test.
- `SKILL.md` names the rule at the step where the CLI already prints it; a rule the CLI does not print stays only in its reference.
- A future CLI message change that removes or narrows one of these lines needs a matching `SKILL.md` and reference update in the same change.
