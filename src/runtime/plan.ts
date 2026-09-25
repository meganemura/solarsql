// Responsibility: what the build step and the adapters must agree on.
// The guard table and its trigger, the text of an assert statement, the
// operation parameter keys, the order of parameter values, the detection of
// an assert failure in an engine error, and the parsing of JSON columns.
// Boundary: no engine access. The adapters call the engine.
import type { ConstraintFailure, SqlValue, StatementMeta } from "../index.ts";

export const GUARD_TABLE = "solarsql_assert";

// One guard table and one trigger serve every assert. raise(abort, new.name)
// takes an expression, so the error message is the assert name.
export const GUARD_DDL: readonly string[] = [
  `create table ${GUARD_TABLE} (name text not null, ok integer not null) strict`,
  `create trigger ${GUARD_TABLE}_check before insert on ${GUARD_TABLE}
  when new.ok = 0
begin
  select raise(abort, new.name);
end`,
];

// Deletes every row in the guard table. An adapter appends this as the last
// statement of a plan that has at least one assert, once every assert has
// passed and any returns clause has read what it needs: a passing assert's
// row has no further use, so nothing keeps the table from returning to zero
// between commands (ADR 0093).
export const GUARD_CLEANUP = `delete from ${GUARD_TABLE}`;

const ASSERT_IDENTITY = "solarsql:assert:";

export function assertToken(): string {
  return crypto.randomUUID();
}

// The predicate is any SQL expression; SQLite's own truthiness decides
// pass or fail here, the same as inside a WHERE clause. Wrapping it keeps
// the stored value exactly 0 or 1, so a NULL or non-numeric predicate
// fails as a normal assert instead of failing the guard table's own NOT
// NULL/STRICT constraint (ADR 0095).
//
// The token is bound as a value, not written into the text (ADR 0086
// amendment): the text of every assert of the same name
// and predicate is then the same on every run, so D1's insights group them
// as one statement and workerd's per-text statement cache does not grow
// without bound across many runs (measured: about 5.9 KB RSS per unique
// text, up to the cache's roughly 5,300-text cap). Called with no token
// (from the build, to type the predicate's own parameters only), the
// identity stays embedded in the text: build.ts never runs this SQL, only
// prepares it to read parameter and column types, and typegen.ts refuses
// an anonymous `?` in a typed statement.
export function assertStatement(name: string, predicate: string, token?: string): string {
  if (token === undefined) return `insert into ${GUARD_TABLE} (ok, name) select (case when (${predicate}) then 1 else 0 end), '${name}'`;
  return `insert into ${GUARD_TABLE} (ok, name) select (case when (${predicate}) then 1 else 0 end), '${ASSERT_IDENTITY}' || ? || ':${name}'`;
}

// bindValues()'s own values, with the assert's run-time token appended as
// the last, anonymous value: assertStatement()'s `?` sits after the
// predicate's own named slots (ADR 0071's first-appearance order), so the
// token is always the last value SQLite numbers for this statement.
export function assertBindValues(meta: StatementMeta, params: Record<string, unknown>, token: string): SqlValue[] {
  return [...bindValues(meta, params), token];
}

// Values in the order SQLite numbers the named parameters. A missing value
// is an error here, because an undefined value would bind as nothing. A
// parameter that json_each reads is encoded as JSON text.
export function bindValues(meta: StatementMeta, params: Record<string, unknown>): SqlValue[] {
  const missing = meta.params.filter((n) => !Object.hasOwn(params, n) || params[n] === undefined);
  if (missing.length > 0) throw new Error(`missing parameter${missing.length > 1 ? "s" : ""}: ${missing.map((n) => JSON.stringify(n)).join(", ")}`);
  return meta.params.map((n) => {
    const v = params[n];
    if (meta.encode.includes(n) && typeof v !== "string") return JSON.stringify(v);
    return v as SqlValue;
  });
}

export function validateParams(metas: readonly StatementMeta[], params: Record<string, unknown>, subject: string): void {
  const keys = [...new Set(metas.flatMap(meta => meta.params))].sort();
  const wanted = new Set(keys);
  const missing = keys.filter(key => !Object.hasOwn(params, key) || params[key] === undefined);
  const unexpected = Object.keys(params).filter(key => !wanted.has(key)).sort();
  const parts = [
    ...(missing.length > 0 ? [`missing parameter${missing.length > 1 ? "s" : ""}: ${missing.map(key => JSON.stringify(key)).join(", ")}`] : []),
    ...(unexpected.length > 0 ? [`unexpected parameter${unexpected.length > 1 ? "s" : ""}: ${unexpected.map(key => JSON.stringify(key)).join(", ")}`] : []),
  ];
  if (parts.length > 0) throw new Error(`${parts.join("; ")} (${subject} declares: ${keys.length > 0 ? keys.join(", ") : "none"})`);
}

// The assert name when an error is the guard trigger firing, else null.
// node:sqlite reports the raise message alone with errcode 1811. D1 and a
// Durable Object report `<name>: SQLITE_CONSTRAINT (extended:
// SQLITE_CONSTRAINT_TRIGGER)`, and D1 adds a `D1_ERROR: ` prefix.
export function assertFailure(error: unknown, asserts: readonly string[], token: string): string | null {
  const e = errorDetails(error);
  const isTrigger = e.errcode === 1811 || e.message.includes("SQLITE_CONSTRAINT_TRIGGER");
  if (!isTrigger) return null;
  const prefix = `${ASSERT_IDENTITY}${token}:`;
  const body = bareMessage(error);
  if (!body.startsWith(prefix)) return null;
  const name = body.slice(prefix.length);
  return asserts.includes(name) ? name : null;
}

// JSON columns arrive as text from the engine. The generated meta says which.
export function parseJson<R extends Record<string, unknown>>(rows: readonly Record<string, unknown>[], json: readonly string[], format: "native" | "d1" = "native"): R[] {
  return rows.map((row) => {
    const out = { ...row };
    // Raw D1 BLOBs are byte arrays; Durable Object BLOBs are ArrayBuffers.
    // Decode those before JSON text, whose arrays must remain JSON arrays.
    for (const [key, value] of Object.entries(out)) {
      if (value instanceof ArrayBuffer) out[key] = new Uint8Array(value);
      else if (format === "d1" && Array.isArray(value)) out[key] = new Uint8Array(value);
    }
    for (const c of json) {
      const v = out[c];
      if (typeof v === "string") out[c] = JSON.parse(v);
    }
    return out as R;
  });
}

// Unknown thrown values include null and objects with inaccessible fields.
// Decline classification rather than replacing the original failure.
export function errorDetails(error: unknown): { message: string; errcode?: number } {
  try {
    if (error === null || (typeof error !== "object" && typeof error !== "function") || error instanceof AggregateError) return { message: "" };
    const e = error as { message?: unknown; cause?: unknown; errcode?: unknown };
    const cause = e.cause;
    const causeMessage = cause !== null && (typeof cause === "object" || typeof cause === "function") ? (cause as { message?: unknown }).message : undefined;
    const message = typeof causeMessage === "string" ? causeMessage : e.message;
    const errcode = e.errcode;
    return { message: typeof message === "string" ? message : "", ...(typeof errcode === "number" ? { errcode } : {}) };
  } catch { return { message: "" }; }
}

// The message of an engine error without the D1 prefix, D1's own
// end-of-batch reset prefix, and the extended result code suffix that D1
// and a Durable Object append. D1 raises the reset prefix when a deferred
// constraint (for example a foreign key deferred past the statements a
// caller sent) fails at D1's own implicit commit rather than at the
// statement that caused it; SQLite's own constraint text follows the
// colon, so stripping the prefix exposes it unchanged.
export function bareMessage(error: unknown): string {
  const message = errorDetails(error).message;
  return message
    .replace(/^D1_ERROR:\s*/, "")
    .replace(/^Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated:\s*/, "")
    .replace(/:\s*SQLITE_CONSTRAINT(?:_[A-Z]+)?\s*(?:\(extended:[^)]*\))?\s*$/, "");
}

// A constraint failure as a value, when the error is one. The text formats
// are the same on node:sqlite, D1, and a Durable Object.
export function constraintFailure(error: unknown): ConstraintFailure | null {
  const m = bareMessage(error);
  let match: RegExpExecArray | null;
  if ((match = /^UNIQUE constraint failed: index '((?:[^']|'')*)'$/.exec(m))) return { kind: "unique_index", index: match[1]!.replaceAll("''", "'") };
  if ((match = /^UNIQUE constraint failed: (.+)$/.exec(m))) {
    const refs = match[1]!.split(",").map((r) => r.trim().split("."));
    if (refs.some(ref => ref.length !== 2 || ref.some(name => name.length === 0))) return null;
    const table = refs[0]![0]!;
    if (refs.some(ref => ref[0] !== table)) return null;
    return { kind: "unique", table, columns: refs.map((ref) => ref[1]!) };
  }
  if ((match = /^CHECK constraint failed: (.+)$/.exec(m))) return { kind: "check", constraint: match[1]! };
  if ((match = /^NOT NULL constraint failed: ([^.]+)\.([^.]+)$/.exec(m))) return { kind: "not_null", table: match[1]!, column: match[2]! };
  if (/^FOREIGN KEY constraint failed$/.test(m)) return { kind: "foreign_key" };
  if ((match = /^cannot store (\w+) value in (\w+) column ([^.]+)\.([^.]+)$/.exec(m))) {
    return { kind: "datatype", table: match[3]!, column: match[4]!, stored: match[1]!, declared: match[2]! };
  }
  return null;
}

export type EngineMeta = { rows_read: number; rows_written: number; duration?: number; served_by_region?: string; served_by_primary?: boolean };

// Where in the plan an unclassified error or a constraint failure happened
// (ADR 0137): a plan item by its 1-based position and the total, the
// returns clause, or a read of a batch. `sql` is the catalog text (no
// bound values); an assert's own text carries the run-time token as a
// bound value now (ADR 0086's amendment), so `sql` for a failing assert is
// its predicate, the same text the catalog names it by, not the text the
// adapter sent. `included` names the including command's included range
// when the position falls inside one. D1 never sets this: a failed batch
// names no index (D1's own `batch()` contract), and D1's engine errors
// carry nothing this adapter could attribute to one statement.
export type At = { position: number; of: number; sql: string; included?: string } | { returns: true; sql: string };

// One entry per plan item (a statement or an assert) in expanded-plan
// order, then one for `returns` when the command has one (ADR 0039's
// 2026-09-25 section): the rows D1's own reply or a Durable Object's own
// cursor reports for that one statement. Guard cleanup and the
// total_changes() probes are not plan items and get no entry. Reported
// only when every entry has both counters, so index i always means
// position i + 1 without a caller having to skip a hole.
export type StatementRow = { rows_read: number; rows_written: number; duration?: number };

type Event = { kind: "query" | "batch" | "command"; name: string; ms: number; outcome: string; meta?: EngineMeta; at?: At; statements?: readonly StatementRow[] };

// What a call in progress may tell observed() about itself, accumulated
// across as many report() calls as the body needs: an adapter clears `at`
// once an item finishes (so a probe, cleanup, or commit failure after the
// last item leaves no `at`) and sets `meta`/`statements` once, at the end.
export type ObserveReport = { meta?: EngineMeta | undefined; at?: At | undefined; statements?: readonly StatementRow[] | undefined };

// Time one call and report it to the observe hook. The body gets a
// `report` for what it learns about itself as it runs: the engine's meta,
// when the engine gives one, and (ADR 0137, ADR 0039) `at` and
// `statements`. Each call merges into the last -- a later `at: undefined`
// clears a previous one, but an omitted key leaves its last value alone --
// so the body can narrate a run item by item without losing what it
// reported before.
export async function observed<T>(hook: ((event: Event) => void) | undefined, kind: "query" | "batch" | "command", name: string, body: (report: (info: ObserveReport) => void) => Promise<T>, outcomeOf: (value: T) => string): Promise<T> {
  let state: ObserveReport = {};
  const report = (info: ObserveReport) => {
    state = { ...state, ...info };
  };
  if (!hook) return body(report);
  const start = performance.now();
  const event = (outcome: string): Event => ({
    kind, name, ms: performance.now() - start, outcome,
    ...(state.meta ? { meta: state.meta } : {}),
    ...(state.at ? { at: state.at } : {}),
    ...(state.statements ? { statements: state.statements } : {}),
  });
  const notify = (outcome: string) => {
    // Telemetry runs after the database outcome. Its failure must not make
    // a committed command appear to fail or replace an engine error.
    try { void Promise.resolve(hook(event(outcome))).catch(() => {}); }
    catch { /* The observer owns telemetry error reporting. */ }
  };
  let value: T;
  try { value = await body(report); }
  catch (e) { notify("error"); throw e; }
  notify(outcomeOf(value));
  return value;
}

// The meta of one reply or of a batch of replies, as D1 reports it: the
// rows and the duration summed, the region and the primary flag from the
// first reply that names them. Undefined when no reply carries numbers.
export function engineMeta(replies: readonly { meta?: unknown }[]): EngineMeta | undefined {
  let out: EngineMeta | undefined;
  for (const r of replies) {
    const m = r.meta as Partial<Record<keyof EngineMeta, unknown>> | undefined;
    if (!m || typeof m.rows_read !== "number" || typeof m.rows_written !== "number") continue;
    const duration = typeof m.duration === "number" ? m.duration : 0;
    if (!out) {
      out = { rows_read: m.rows_read, rows_written: m.rows_written, duration };
      if (typeof m.served_by_region === "string") out.served_by_region = m.served_by_region;
      if (typeof m.served_by_primary === "boolean") out.served_by_primary = m.served_by_primary;
    } else {
      out.rows_read += m.rows_read;
      out.rows_written += m.rows_written;
      // out.duration is only optional in the type (durable.ts's DO meta
      // omits it); every reply this loop sums here comes from D1, which
      // always sets duration, defaulted to 0 above, so the running total is
      // always a number by the time a second reply reaches this branch.
      out.duration = (out.duration ?? 0) + duration;
    }
  }
  return out;
}

// One `StatementRow` per D1 reply, not summed (ADR 0039's 2026-09-25
// section): `undefined` when any reply lacks both counters, the same
// both-required rule `engineMeta()` applies, so a caller is never left
// guessing which index a hole belongs to.
export function d1StatementRows(replies: readonly { meta?: unknown }[]): StatementRow[] | undefined {
  const rows: StatementRow[] = [];
  for (const r of replies) {
    const m = r.meta as Partial<Record<keyof EngineMeta, unknown>> | undefined;
    if (!m || typeof m.rows_read !== "number" || typeof m.rows_written !== "number") return undefined;
    rows.push({ rows_read: m.rows_read, rows_written: m.rows_written, ...(typeof m.duration === "number" ? { duration: m.duration } : {}) });
  }
  return rows;
}

export function outcomeOf(result: { ok: boolean; kind?: string; assert?: string }): string {
  if (result.ok) return "ok";
  return result.kind === "assert" ? `assert:${result.assert}` : (result.kind ?? "error");
}
