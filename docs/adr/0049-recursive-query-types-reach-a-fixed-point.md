# ADR 0049: Recursive query types reach a fixed point

Status: accepted (2026-09-13). Extends ADR 0048 for recursive CTEs with a SELECT seed and UNION branches.

## Context

A process tree is naturally expressed as a recursive CTE.
Rejecting that SQL requires callers to replace a familiar database operation with application code.
The recursive step can introduce types that the initial SELECT does not return.

## Decision

Start from the non-recursive SELECT seed's output types.
Resolve the recursive references against those types, then merge the branch outputs by column position.
Repeat until both the types and JSON decoding policy stop changing.
Only a stable result becomes the generated contract.
Explicit CTE column names apply to both the seed and recursive references.

Limit inference to 32 steps and 65536 total characters in the merged column types.
Exceeding either limit produces a build error; it never emits the partial result.
These limits bound type analysis, not the SQL query's execution.
The caller controls query termination, including UNION deduplication and recursive predicates.
ADR 0050 extends the seed forms to VALUES.

## Evidence

The recursive tests compare real SQLite rows for empty graphs, chains, and cycles.
A column-swapping query requires types introduced after the seed.
A recursive JSON query checks the text representation at the CTE boundary.

## Consequences

Recursive tree queries can retain their SQL and generated result contracts.
Some valid recursive expressions still need CAST or additional inference support.
The stable type union accounts for all analyzed branches, including branches that return no row in a particular database.
