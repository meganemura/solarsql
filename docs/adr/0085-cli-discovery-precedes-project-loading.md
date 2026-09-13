# ADR 0085: CLI discovery precedes project loading

Status: accepted (2026-09-14)

## Context

A caller needs the installed version and supported commands before it can operate an unfamiliar project.
The CLI previously treated help and version requests as invalid commands.
Some command paths also dispatch workers before they load application configuration.

## Decision

Handle explicit help and version requests before command execution and worker dispatch.
Print successful discovery output to stdout and exit 0.
Read the version from the package metadata beside the source or compiled CLI.
Support global help, command help, and short help and version aliases.
Reject unknown help targets and additional discovery arguments with usage on stderr and exit 2.
Keep application operations under their existing command handlers.

## Evidence

The same checks run against the source CLI and a packed, installed CLI.
Each check uses a fresh directory with a configuration file that throws if imported.
Checks cover every command, aliases, installed version equality, invalid requests, and unchanged directory contents.
