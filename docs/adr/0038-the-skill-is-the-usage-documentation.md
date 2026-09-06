# ADR 0038: The skill is the usage documentation, and the README is the door

Status: accepted (2026-09-06)

## Context

The README held every rule of the library in one file of three hundred lines, written for a human reader in order.
An agent that starts from an empty context loads what its step needs, and a rule it needs sat between paragraphs it did not.
Agent skills are a directory with a `SKILL.md` and `references/`, and a package can ship one.

## Decision

`skills/solarsql/SKILL.md` is the master of the usage documentation.
It holds the shape, a workflow whose steps name the reference to load, and the rules the build enforces, one line each.
`skills/solarsql/references/` holds the rules by task: schema, queries, commands, running, build, migrations, deploy.
The README is the door for a human: what it is, how to start, the shape, a table that points into the references, the requirements.
A rule is written once, in a reference; the README and the SKILL.md point at it.
The package ships `skills/`, so a project has the skill at `node_modules/solarsql/skills/solarsql/SKILL.md`, and `init` says so.
The ADRs stay the design records: the references say what holds, the ADRs say why.

## Why

A reference per task keeps the rule where the step is, and an agent loads one file.
The message table in `build.md` is the build's feedback loop written down: an agent reads a message and finds its fix in one place.
One source keeps the two readers from drifting apart.

## Consequences

- A test keeps the skill honest: every reference is linked from `SKILL.md`, every relative link resolves, and every message fragment in `build.md` appears in the source of the build.
- No script generates the README: it is short enough to keep by hand, and the test catches a broken link.
- The experiment kit's starter names the skill next to the README in its AGENTS.md.
