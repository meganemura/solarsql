# ADR 0078: JSON object types follow decoded keys

Status: accepted (2026-09-13)

## Context

SQLite can return JSON text containing a repeated object key.
The adapters use JSON.parse, which retains the last value for that key.
Generating every occurrence produced duplicate TypeScript fields with conflicting types.
Comments around literal keys also caused valid SQL to fail analysis.

## Decision

Generate one field per decoded key, using the final occurrence's value type.
Read each literal key from its significant SQL token, after removing enclosing parentheses.
Retain comments and original SQL in the statement.
Continue to reject dynamic keys because they cannot define a fixed object contract.

## Evidence

A property test varies escaped keys and verifies the generated field against the decoded SQLite result.
Examples cover nested objects, repeated keys, and a key named `__proto__`.
A generated caller repeats a key before a JSONB value and runs on Node, local D1, and local Durable Objects.
