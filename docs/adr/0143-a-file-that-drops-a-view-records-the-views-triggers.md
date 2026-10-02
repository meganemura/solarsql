# ADR 0143: a file that drops a view records the view's triggers

Status: accepted (2026-10-02). Extends ADR 0102 and ADR 0116 from a rebuilt table's triggers to the triggers of a dropped view.

## Context

`DROP VIEW` drops the triggers on that view, and ADR 0142 makes a generated file create the declared triggers on that view again after the view. A sibling migration merged ahead of the file can still change those triggers after the file was generated. Measured with node:sqlite 3.53.4 and `migrate()` through Node's storage shim:

- A sibling that adds `instead of insert on v` ahead of a file that rebuilds `v`'s base table: `applied()` and `migrate()` both accepted the file, and the trigger was gone afterwards.
- The same with a table trigger was already refused (`REBUILD_LOSES_COLUMN`), because the rebuild record lists the table's triggers.

The changed-view path has no rebuild record at all, so nothing recorded what a dropped view had.

## Decision

- A generated file that drops a view writes one more header line, `-- Drops views with these triggers: `, with a JSON list of `{ view, triggers }`: each view the file drops, and the normalized text of each trigger that view had when the file was generated. A view with no triggers is listed with an empty list, so a trigger a sibling adds to it later is still caught.
- Before a replay runs such a file, `applied()` and `migrate()` compare each listed view's triggers in the schema the file starts from with the record, the same two ways a rebuilt table's triggers are compared:
  - A trigger the record does not list would be dropped with the view and not created again. The file is refused (ADR 0102's direction).
  - A trigger the record lists, that an earlier migration removed, and that the file's own statements create again, would come back. The file is refused (ADR 0116's direction).
- Both refusals use the existing codes, `REBUILD_LOSES_COLUMN` and `REBUILD_REVIVES_DECLARATION`, and name the view and the trigger.
- A view the record lists that the starting schema no longer has is skipped; the file's own `DROP VIEW` then fails on its own.
- A file without the header, written before this decision or by hand, is not checked this way.
- Trigger tables match under SQLite's identifier case rule, both here and in the rebuild record, because an `ON` clause can spell the table in another case.

## Consequences

- A sibling migration can no longer drop or revive a view trigger through a generated file without a refusal, on either drop path: a rebuild of the view's base table, or a changed view.
- Generated files that drop a view carry one more header line.
