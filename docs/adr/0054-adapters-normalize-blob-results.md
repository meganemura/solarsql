# ADR 0054: Adapters normalize BLOB results

Status: accepted (2026-09-13)

## Context

Generated BLOB types use `Uint8Array`.
D1 returns byte arrays, and Durable Object storage returns ArrayBuffers.
An ANY column can also return a BLOB.

## Decision

Convert raw BLOB representations to `Uint8Array` before decoding JSON text.
This order preserves JSON arrays as ordinary arrays.
Keep the number contract for INTEGER results and document safe integer limits by target.
Engine metadata supplies column facts; scope and expression analysis derives the result types from those facts.

## Evidence

Local Cloudflare tests check both adapters, including batch reads.
Hegel tests check byte preservation, JSON arrays, NULL, and Node scalar round trips.
These tests provide local runtime evidence; remote deployment checks remain separate.
