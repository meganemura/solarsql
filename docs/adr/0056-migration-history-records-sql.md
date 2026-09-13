# ADR 0056: Migration history records SQL

Status: accepted (2026-09-13)

## Context

A file name does not detect changed migration contents or an inserted historical file.
The synchronous Durable Object runner needs a comparison that requires no asynchronous hash service.

## Decision

Node and Durable Object migration history stores the complete SQL text.
Before applying new files, validate duplicates and require the applied history to match a prefix of the supplied files.
Compare the recorded SQL exactly. Reject missing, changed, and out-of-order files with structured errors.
The runner owns transactions and rejects transaction control statements in files.

Legacy name-only history requires explicit adoption after the caller checks the old files.
Adoption records a trusted baseline; it does not reconstruct historical evidence.
D1 migrations managed by wrangler keep their separate history contract.

## Consequences

History uses space proportional to migration SQL.
Whitespace changes to applied SQL are rejected.
Each new file remains atomic, while earlier successful files remain applied if a later file fails.
