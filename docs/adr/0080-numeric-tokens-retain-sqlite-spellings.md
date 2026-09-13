# ADR 0080: Numeric tokens retain SQLite spellings

Status: accepted (2026-09-13)

## Context

SQLite accepts uppercase hexadecimal prefixes, numeric digit separators, and decimal points before exponents.
The scanner split some of these literals into several tokens.
The generator then rejected a number whose storage class was already known.

## Decision

Read a complete numeric token using SQLite's decimal and hexadecimal forms.
Allow one separator between digits, including fractional and exponent digits.
Retain each token's exact text and source span.
The existing literal inference assigns the number contract through query scopes and JSON values.
SQLite validates malformed syntax before analysis.

## Evidence

A property test compares safe integer spellings with engine values through SELECT, VALUES, and CTEs.
Examples cover fractional values, exponents, signs, malformed separators, and parameter boundaries.
Generated numeric spellings execute on Node, local D1, and local Durable Objects.
