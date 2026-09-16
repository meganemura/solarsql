# ADR 0114: The build also refuses a denied function inside DDL

Status: accepted (2026-09-16)

## Context

ADR 0113 made `Engine.prepare()` (`src/build/facts.ts`) deny a query or a command plan item that calls a SQL function outside a local copy of D1 and a Durable Object's own SQLite allowlist. That decision named its own unmeasured adjacent scope: DDL. The `Engine` constructor runs every `CREATE TABLE`, `CREATE VIEW`, and `CREATE TRIGGER` statement through `this.db.exec(s)`, with no authorizer at all, so a function call written directly inside a CHECK constraint, a view body, or a trigger body was not checked by that decision.

This round measured that boundary directly, in `node:sqlite` and against real D1 and Durable Object storage (Miniflare), across five DDL shapes.

### CHECK constraints: no indirect catch path

```sql
create table t2 (id text primary key not null, a text, check (a != sqlite_version()))
```

The `Engine` constructor accepts this DDL (no authorizer). Every later `Engine.prepare()` call on `t2` -- an `insert` and an `update` -- also accepts it: SQLite resolves a CHECK expression once, at this `CREATE`, and never reconsiders it on a later `INSERT` or `UPDATE`, so no query ever re-triggers the function-call authorizer's check on it. D1 and a Durable Object's own storage both refuse the identical `CREATE TABLE` outright, at `CREATE`, with `not authorized to use function: sqlite_version`; the table is never created there at all. Of the five shapes, this is the only one with no indirect catch path through any later query.

### View bodies: a real indirect catch path, but not a structural one

```sql
create view v1 as select cast(sqlite_version() as text) as v
```

The constructor accepts the `CREATE VIEW` (a view's body is not compiled at `CREATE`). `Engine.prepare("select * from v1")` correctly refuses it, matching D1 and a Durable Object: `CREATE VIEW` succeeds there too, and the first `select` against the view is what fails. So a query that actually selects from the view is already covered by ADR 0113. But the build's own structural per-view boundary check (`src/build/build.ts`, one `checkBoundary` call per declared view) used `engine.accesses(sql)`, a permissive authorizer that always returns `SQLITE_OK` and never denies a function call. A view no query in its module ever selects -- an orphan view -- reached only that permissive check, and passed silently.

### Trigger bodies: the same root cause

`src/build/build.ts`'s `checkTriggerBoundary` builds a synthetic statement of the trigger's own event (for example `insert into t3 default values`) and passes it through the same `checkBoundary` -> `engine.accesses()` path, also permissive. `Engine.prepare()` on that exact synthetic statement correctly refuses a denied function in the trigger body. So a trigger whose event some real plan item also exercises is already covered indirectly by ADR 0113 (compiling that plan item's statement also compiles the trigger body it fires). An orphan trigger -- one no plan item's event ever exercises -- reached only the permissive structural check.

### DEFAULT expressions: no gap today, a named future risk

```sql
create table t1 (id text primary key not null, a text default (sqlite_version()))
```

`CREATE`, and a later `insert into t1 (id) values ('x')` that uses the default, both succeed identically on `node:sqlite`, D1, and a Durable Object today -- no divergence was measured. `cloudflare/workerd` carries a patch, `patches/sqlite/0006-call-authorizer-in-default-column-expressions.patch` (332 lines, committed `2026-09-02T15:50:09Z`), that adds an authorizer check for exactly this case to SQLite's own `build.c`, `expr.c`, `fkey.c`, and `insert.c`. This project pins `miniflare@5.20260828.0-alpha`, a workerd build from before that patch's commit date, which is consistent with measuring no divergence now. If a future Miniflare update carries that patch, a DEFAULT expression's function call could start failing on D1 and a Durable Object while `node:sqlite` still accepts it -- the same class of gap this decision closes for CHECK, view, and trigger bodies. This decision does not add a check for DEFAULT expressions, and no existing test would catch that future drift either: `test/function-allowlist.test.ts` exercises a bare `select`, not an `insert` that relies on a column's default.

### GENERATED ALWAYS AS: already refused everywhere, for unrelated reasons

```sql
... g text generated always as (sqlite_version()) virtual
```

`node:sqlite` refuses this itself, by SQLite's own core rule that a generated column's expression must be deterministic -- unrelated to any authorizer. D1 and a Durable Object refuse it too, through their authorizer's message. Both already refuse it, for different reasons; this decision adds nothing here.

## Decision

Three sites gate the same allowlist ADR 0113 established, using the same call-scoped `setAuthorizer()` shape: set the deny authorizer, run one statement, clear it in a `finally`, whatever that statement does. The shape is factored into one function, `withDeniedFunctions()` (`src/build/facts.ts`), so all three sites share it instead of three copies of the same `setAuthorizer`/`finally` pair.

1. **The `Engine` constructor's DDL loop.** Each `CREATE` statement is now run inside `withDeniedFunctions()`, in the loop's existing per-statement `try`/`catch` (which already closes the connection and attaches the failing statement's text to the error) -- the natural place to add the wrapper, since it already treats each statement on its own. This closes the CHECK-constraint gap, the most severe of the five shapes: it is caught at `CREATE`, the same point D1 and a Durable Object refuse it.
2. **The structural per-view and per-trigger boundary checks (`src/build/build.ts`).** Each now also calls `engine.prepare()` on the same synthetic statement `checkBoundary`'s `engine.accesses()` call already inspects for table accesses -- `select * from <view>` for a view, the trigger's own synthetic firing statement for a trigger. `engine.prepare()` runs first, so a denied function is reported before `checkBoundary`'s own boundary-crossing check runs.
3. **`migration.ts`'s `applied()` replay loop.** `applied()` re-runs every migration file's DDL, one statement at a time, to reconstruct the schema a fresh deploy target would have after replaying migration history -- the closest local model of what `wrangler d1 migrations apply` and a Durable Object's own `migrate()` (`src/durable.ts`) actually run. The `Engine` constructor checks the *current declared* schema, built from `module.ts` sources; it never sees a migration file already on disk. A file generated before this decision existed, or edited by hand, reaches a function-call denial only through `applied()`'s replay. Before wrapping this loop, `migration.ts`'s own replay logic was checked for a call to a denied function it might make itself (a `grep` for `sqlite_version`/`sqlite_source_id` found none); wrapping only `db.exec(s)` inside the per-file loop, not `db.exec("begin")`/`db.exec("commit")` around it, is enough, since only the migration's own statements can contain a function call.

### Where `prepare()` is not added

`checkBoundary` itself gained no new `prepare()` call. It has a third caller, for an ordinary query or command plan item (`src/build/build.ts`, after `Typer.analyze()`), and `Typer.analyze()` already calls `engine.prepare()` on that exact same statement before `checkBoundary` runs. Adding `prepare()` inside `checkBoundary` would prepare that statement a second time, for no new coverage; adding it only at the two synthetic call sites (view, trigger) keeps the ordinary-query path exactly as ADR 0113 left it.

### View error naming

`checkTriggerBoundary` already wrapped a non-`BuildError` exception with the trigger's own name (`module ${m.name}: trigger ${t.name}: ...`), so adding `engine.prepare(firing)` inside its existing `try` gets that name for free. The per-view call site had no equivalent wrap; one was added, in the same shape, so a denied function in a view's body names the view the same way a denied function in a trigger's body names the trigger.

### Out of scope

- DEFAULT expressions: no divergence measured today; the future risk above is recorded, not acted on.
- `GENERATED ALWAYS AS` columns: already refused everywhere, by unrelated mechanisms.
- `migration.ts`'s `open()`: a third `db.exec` DDL entry point, left unwrapped, because both of its callers already feed it DDL that passed one of the two other gated sites in the same build run. `build.ts`'s `migrationStatus()` calls `open(declaredDdl(modules))` with the exact list the `Engine` constructor already validated earlier in the same `build()` call. `migration.ts`'s own rebuild-candidate path calls `open([current.sql, ...keptIndexes])` with `current.sql`, a table's `CREATE TABLE` text read back from the schema `applied()` just replayed. Neither caller introduces DDL text that `open()` is the first thing to see.

### A pre-existing comment's overgeneralization, corrected in the same change

`migration.ts`'s own comment on the double-quoted-string fallback (near the `unknown` column check in `applied()`) said D1 and a Durable Object "actually replay this file, since wrangler applies a migration file with no solarsql check in between". That is accurate for D1, where `wrangler d1 migrations apply` runs the file's statements as the file holds them. It overgeneralized for a Durable Object: its own real replay path, `migrate()` in `src/durable.ts`, does run solarsql checks for that file -- a lost column, constraint, index, or trigger -- once, before that file's own statements run. The comment now names each engine's real path instead of one shared justification.

## Consequences

- A CHECK constraint, a view body, or a trigger body that calls a function outside the allowlist is refused at build time, with the same message D1 and a Durable Object give, instead of only failing once the schema (or, for a view or an orphan trigger, the first query or event that reaches it) is deployed.
- An orphan view (no query selects it) and an orphan trigger (no plan item fires its event) are both now checked, closing the one case ADR 0113 could not reach even indirectly.
- A migration file already on disk, generated before this decision or edited by hand, is checked the next time `solarsql build` or `solarsql migration` replays it, not only the current declared schema.
- The example project's `example/migrations/*.sql` were swept beforehand with a logging (always-`SQLITE_OK`) authorizer in place of the deny authorizer: seven internal function names appeared (`glob`, `length`, `like`, `printf`, `substr`, `sqlite_rename_table`, `sqlite_rename_test`), all already on the allowlist, and no statement failed. `npm test` after wrapping all three entry points confirms this: no existing test's DDL was refused.
- DEFAULT expressions remain unchecked, but a future divergence there now has a test that would surface it: `test/function-allowlist.test.ts` pins, on D1 and a Durable Object, that an `insert` relying on a `default (sqlite_version())` column succeeds today. That test starts failing the day a pinned Miniflare build carries `patches/sqlite/0006-call-authorizer-in-default-column-expressions.patch` (committed `2026-09-02T15:50:09Z`, after the currently pinned build's date).

## Addendum (2026-09-17): a second declared-DDL shape gets the same build-time refusal, for an unrelated reason

A `references ... deferrable initially deferred` foreign key (column-level or, as a table constraint, `foreign key (...) references ... deferrable initially deferred`) is valid SQLite. `Engine`'s own constructor still accepts it, the same as any other `CREATE TABLE`: the deferred flag does not appear in `pragma_foreign_key_list`'s columns at all, so `facts.ts`'s `foreignKeys` cannot see it, and the migration diff already treats a deferred and an immediate foreign key as the same shape. The gap this addendum closes is not a function call; it is that D1 and a Durable Object's own `run()` (`src/d1.ts`, `src/durable.ts`) cannot classify or catch a violation of this kind of foreign key. On D1, `run()` falls through to an unclassified `throw`. On a Durable Object, the violation is not raised by `transactionSync`'s own RELEASE at all: it surfaces only at the request's own implicit commit, after `run()` already returned a value its caller never receives, and the platform resets the object and returns its own 500 response in place of whatever `run()` resolved to.

`src/build/build.ts`'s per-table validation loop -- a different site from this ADR's three, which sit in the `Engine` constructor's DDL loop, the per-view and per-trigger boundary checks, and `applied()`'s replay -- now refuses this declaration alongside its existing primary-key, STRICT, and foreign-key-target checks. A table's declared `CREATE TABLE` text (not `pragma_foreign_key_list`, which cannot express the modifier) is tokenized and checked for the exact three-token sequence `DEFERRABLE INITIALLY DEFERRED`. `NOT DEFERRABLE`, a bare `DEFERRABLE`, and `DEFERRABLE INITIALLY IMMEDIATE` are SQLite's ordinary immediate behavior and are not refused; only the one sequence that defers a foreign key's exception past the write that violates it is. Adding a per-call `pragma foreign_key_check` scan to `run()` itself (the shape `migrate()` already uses, once per file) was considered and rejected: `run()` executes on every command, not once per migration file, so that scan would cost every command using it, to guard against a schema shape a declaration-time refusal already prevents from existing.

`solarsql`'s own generated migrations use `pragma defer_foreign_keys = on` for a rebuild (`migration.ts`'s `needsDefer`), unaffected by this refusal: that pragma is session-scoped, set and cleared around one rebuild, not a permanent schema declaration a table carries forever.
