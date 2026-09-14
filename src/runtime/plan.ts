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
export function assertStatement(name: string, predicate: string, token?: string): string {
  const identity = token === undefined ? name : `${ASSERT_IDENTITY}${token}:${name}`;
  return `insert into ${GUARD_TABLE} (name, ok) select '${identity}', (case when (${predicate}) then 1 else 0 end)`;
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

export function validateParams(metas: readonly StatementMeta[], params: Record<string, unknown>): void {
  const keys = [...new Set(metas.flatMap(meta => meta.params))].sort();
  const wanted = new Set(keys);
  const missing = keys.filter(key => !Object.hasOwn(params, key) || params[key] === undefined);
  const unexpected = Object.keys(params).filter(key => !wanted.has(key)).sort();
  const parts = [
    ...(missing.length > 0 ? [`missing parameter${missing.length > 1 ? "s" : ""}: ${missing.map(key => JSON.stringify(key)).join(", ")}`] : []),
    ...(unexpected.length > 0 ? [`unexpected parameter${unexpected.length > 1 ? "s" : ""}: ${unexpected.map(key => JSON.stringify(key)).join(", ")}`] : []),
  ];
  if (parts.length > 0) throw new Error(parts.join("; "));
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
function errorDetails(error: unknown): { message: string; errcode?: number } {
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

// The message of an engine error without the D1 prefix and the extended
// result code suffix that D1 and a Durable Object append.
function bareMessage(error: unknown): string {
  const message = errorDetails(error).message;
  return message.replace(/^D1_ERROR:\s*/, "").replace(/:\s*SQLITE_CONSTRAINT(?:_[A-Z]+)?\s*(?:\(extended:[^)]*\))?\s*$/, "");
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

export type EngineMeta = { rows_read: number; rows_written: number; duration: number; served_by_region?: string; served_by_primary?: boolean };

type Event = { kind: "query" | "batch" | "command"; name: string; ms: number; outcome: string; meta?: EngineMeta };

// Time one call and report it to the observe hook. The body gets a
// `report` for the engine's meta, when the engine gives one.
export async function observed<T>(hook: ((event: Event) => void) | undefined, kind: "query" | "batch" | "command", name: string, body: (report: (meta: EngineMeta | undefined) => void) => Promise<T>, outcomeOf: (value: T) => string): Promise<T> {
  let meta: EngineMeta | undefined;
  const report = (m: EngineMeta | undefined) => {
    meta = m;
  };
  if (!hook) return body(report);
  const start = performance.now();
  const event = (outcome: string): Event => ({ kind, name, ms: performance.now() - start, outcome, ...(meta ? { meta } : {}) });
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
      out.duration += duration;
    }
  }
  return out;
}

export function outcomeOf(result: { ok: boolean; kind?: string; assert?: string }): string {
  if (result.ok) return "ok";
  return result.kind === "assert" ? `assert:${result.assert}` : (result.kind ?? "error");
}
