# ADR 0101: A rebuild records the shape it saw, and replay refuses a stale one

Status: accepted (2026-09-15)

## Context

ADR 0099 has a migration file that rebuilds a table record the column names its generator saw for that table, and has replay refuse the rebuild if the table's actual columns include one absent from that list. This closes the gap where one branch adds a column and a sibling's independently generated rebuild, merged and renumbered after it, never learns the column exists.

The same recorded list does not catch a narrower version of the same hazard. Two branches can each rebuild the same table for unrelated reasons and touch no column the other does not already know about. Branch A rebuilds table `t` to drop `NOT NULL` on column `a`; branch B, independently, rebuilds the same table to drop `NOT NULL` on column `c`. Both branches see columns `a` and `c` at generation time, so ADR 0099's column-name check passes for both files. Merged, with B's file applied first and A's file renumbered after it, A's `CREATE TABLE` is generated from a schema snapshot that predates B's change: it declares `c NOT NULL`, the shape as A's generation step saw it, not the shape B already gave it. Replaying A after B silently reverts B's change. This is the same underlying hazard ADR 0099 named — a rebuild's `CREATE TABLE` comes from a schema snapshot, not from the live schema — one level up: at the shape of a column both branches know about, not at whether a column is known at all.

## Decision

A migration file that rebuilds a table records, in the same comment line `render()` writes, each column's normalized declaration text instead of only its name: the same text `definitions()`/`normalize()` already produce, and that `introspect()` already carries as `Column.def`. This is the same comparison `diff()` already uses to decide whether an index or a trigger changed (`normalize(a) !== normalize(b)`), so a difference in case or whitespace between generation time and replay time does not cause a false refusal.

Before a rebuild statement runs, replay reads the table's actual current shape and refuses if a column recorded from generation time no longer matches: text that is present at replay but absent from the recording, exactly as ADR 0099's unknown-column check already did, and now also text that is present in the recording but reads differently at replay. Both checks run in `applied()` (`src/build/migration.ts`) and `migrate()` (`src/durable.ts`), the same two places ADR 0099's check already ran.

A table whose `CREATE TABLE` has no explicit column-definition list — `CREATE TABLE ... AS SELECT`, where `tableBody()`/`definitions()` find no parenthesized body — records every column's declaration as the empty string on both sides. The comparison is then vacuous for that table, the same as a file with no recorded comment at all: this decision leaves that boundary as ADR 0099 already drew it, and adds no new case for it.

This decision replaces ADR 0099's header format: the JSON now holds `{ name, def }` objects instead of bare column-name strings, under a new header line. A file `render()` wrote under ADR 0099's format has the old header text, which this decision's parser does not look for, so such a file is treated as having nothing recorded — unchecked, not refused — the same back-compat boundary ADR 0099 itself established for a file written before either decision existed.

## Why

A column's name being known to a rebuild does not mean its current shape is; the two are different facts, and closing only the first still lets the second kind of accident happen. The fix follows the same shape as ADR 0099's: record what the generator actually saw and compare it, later, against what is actually there.

One alternative considered and rejected: record the whole parenthesized body of the `CREATE TABLE` (`tableBody(sql).body`, normalized) as a single string, instead of a map keyed by column name. This would cover more ground for the same amount of code, including a table-level constraint, and needs no per-column loop. It fails on column order: `ALTER TABLE ... ADD COLUMN` appends a column at the end of the table, but a rebuild's `CREATE TABLE` orders columns by each module's declaration order instead, so two histories can both be legitimate and still arrive at the same set of column declarations in a different order. A whole-body string comparison would flag that reordering as a mismatch. Keying the comparison by column name, and comparing each column's own declaration text independently, keeps this decision insensitive to a column's position.

## Consequences

- This record covers each column's own declaration (`Table.columns[].def`) only. A table-level constraint (`CHECK`, `UNIQUE`, `FOREIGN KEY`, already normalized separately by `definitions()` as `constraints`) is not part of it. Two independent rebuilds that each add or change a different table-level constraint can revert each other's change the same way two rebuilds of a column's shape could before this decision — this record does not detect that case.
- Naming which earlier migration file changed a column's shape, the way ADR 0099's `firstIntroducedBy` names which file added a column, is not part of this decision; the refusal here names the file being replayed, the column, and the two conflicting declarations, not the file that produced the newer one.
- A table whose `CREATE TABLE` has no explicit column-definition list is not covered by this check, for the reason given above; ADR 0099's unknown-column check already had the same gap for such a table, so no case newly needs one.
- `render()`'s output changes only for a migration that rebuilds a table: the recorded JSON now carries an object per column instead of a bare name, under a renamed header line. A file with no rebuild is unchanged, byte for byte.
