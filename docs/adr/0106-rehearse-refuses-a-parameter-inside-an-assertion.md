# ADR 0106: rehearse refuses a parameter inside an assertion

Status: accepted (2026-09-15). Adds one refusal to rehearse's `checks.assertions`.

## Context

Commit `134a51f` ("Reject a parameter in an assertion instead of silently binding it to NULL") added a check to `src/build/rehearse.ts`'s `validateAssertionParams`, before this record existed. `checks.assertions` runs each assertion's SQL with no bound values (`rehearseSnapshot`'s assertion stage calls `.all()` with nothing bound). Before this commit, an assertion's SQL that used a named or anonymous parameter ran anyway: `node:sqlite` silently binds an unbound named parameter to NULL rather than throwing, so a stray `:param` could neutralize the assertion's own predicate instead of failing loudly.

Measured directly (the commit's own added test): an assertion `select count(*) = 0 as ok from orders o where o.user_id = :uid and not exists (select 1 from users u where u.id = o.user_id)`, against data with real orphaned rows, reported `ok: true` before this fix — the unbound `:uid` made the WHERE clause vacuous, so the assertion silently passed on a real violation.

Neither existing ADR admits this refusal. ADR 0057 (rehearse's founding decision) constrains the proposed SQL itself (denies database attachments and transaction control) and names caller-supplied data assertions as one of four checks, alongside integrity, foreign keys, and old query structure; it does not constrain what an assertion's own SQL text may contain. ADR 0088 is a different mechanism: it validates the runtime parameter *object* an adapter binds against a generated operation's declared keys, not a SQL parameter placeholder appearing in `checks.assertions`' SQL text, which is meant to take none.

## Decision

`rehearseSnapshot` refuses `checks.assertions` before running any check: an assertion whose SQL contains a named or anonymous parameter throws `assertion "<name>" takes no parameters, but uses <slots>; bind real values with a case instead`, with diagnostic code `CHECKS_INVALID`. `checks.queries` is exempt: it is only ever compared by column shape, never executed with bound values, so a parameter there carries no false-success risk.

## Why

An assertion expresses the caller's data requirement and must run against every row it names, not a widened set an unbound parameter accidentally lets through. `node:sqlite`'s own NULL-binding default cannot be told apart from a caller's real requirement, so the SQL text is checked instead of trusting the bind.

## Consequences

- An assertion that needs a specific value uses a `case` instead, which binds real parameters and runs before and after the migration.
- `checks.queries` keeps accepting a named parameter; it is compared by column shape only, never executed.
- This adds one refusal to rehearse's `checks.assertions` contract. Neither ADR 0057 nor ADR 0088 is edited.
