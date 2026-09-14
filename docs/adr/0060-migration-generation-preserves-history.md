# ADR 0060: Migration generation preserves history

Status: accepted (2026-09-13)

## Context

File count does not identify the last migration sequence when history has gaps.
Generating the next file from that count can overwrite an existing file.
Two generators can also compute the same next sequence before either writes it.

## Decision

Generation validates numeric prefixes in filename replay order and appends after the maximum sequence.
It preserves the existing digit width, with a minimum of four digits.
Duplicate sequences, malformed names, unsafe integers, and names that would replay before history are rejected.
Applied filenames must remain unchanged during recovery.

A filesystem lock covers history comparison, file creation, and migration-index generation.
The new SQL file also uses exclusive creation, so a competing writer cannot replace an existing file.
Normal completion and failure release the lock.
The generator reports an existing lock and leaves it for its owner to release.

## Boundary

The lock coordinates generators using this protocol on the same filesystem.
It does not coordinate edits in separate git branches or arbitrary manual writers.
A process crash can leave a lock; recovery requires checking that its owner has exited.
Crossing a digit-width boundary can violate filename ordering and requires an explicit migration strategy.

## Consequences

The build command's own write of `migrations/index.ts` takes this same lock.
It rereads the directory after acquiring the lock, so a build racing a migration writes the migration's own result.
