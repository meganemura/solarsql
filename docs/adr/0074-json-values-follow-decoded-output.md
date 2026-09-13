# ADR 0074: JSON values follow decoded output

Status: accepted (2026-09-13)

## Context

SQLite can read valid JSONB from a BLOB column inside a JSON constructor.
The resulting JSON text can contain an object, array, scalar, or null.
The adapters parse that text, but generated types previously described the input BLOB as `Uint8Array`.
Rejecting every BLOB input would reject valid SQLite queries.

## Decision

Export `JsonValue` as a recursive union of JSON strings, numbers, booleans, null, arrays, and objects.
Use it for BLOB and flexible storage values inside `json_object` and `json_group_array`.
Retain precise types for known scalar values and nested JSON constructions.
Generate the required type import with each contract.

Keep the original SQL unchanged.
SQLite still rejects binary content that it cannot use as a JSON value.
The result type describes successful execution; it does not validate stored JSONB content.
A BLOB selected outside a JSON constructor still has the `Uint8Array` contract.
An explicit TEXT conversion inside a constructor retains its text contract.

## Evidence

Tests execute JSONB objects, arrays, scalars, and null from BLOB and ANY columns.
A property test checks nested JSON round trips through JSONB storage and a JSON constructor.
A generated caller compiles and runs on Node, local D1, and local Durable Objects.
Separate checks retain scalar precision, binary output, and SQLite errors for invalid content.
