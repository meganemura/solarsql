// Responsibility: what the build step and the adapters must agree on.
// The guard table and its trigger, the text of an assert statement, the
// order of parameter values, the detection of an assert failure in an
// engine error, and the parsing of JSON columns.
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

export function assertStatement(name: string, predicate: string): string {
  return `insert into ${GUARD_TABLE} (name, ok) select '${name}', (${predicate})`;
}

// Values in the order SQLite numbers the named parameters. A missing value
// is an error here, because an undefined value would bind as nothing. A
// parameter that json_each reads is encoded as JSON text.
export function bindValues(meta: StatementMeta, params: Record<string, unknown>): SqlValue[] {
  const missing = meta.params.filter((n) => params[n] === undefined);
  if (missing.length > 0) throw new Error(`missing parameter${missing.length > 1 ? "s" : ""}: ${missing.map((n) => `:${n}`).join(", ")}`);
  return meta.params.map((n) => {
    const v = params[n];
    if (meta.encode.includes(n) && typeof v !== "string") return JSON.stringify(v);
    return v as SqlValue;
  });
}

// The assert name when an error is the guard trigger firing, else null.
// node:sqlite reports the raise message alone with errcode 1811. D1 and a
// Durable Object report `<name>: SQLITE_CONSTRAINT (extended:
// SQLITE_CONSTRAINT_TRIGGER)`, and D1 adds a `D1_ERROR: ` prefix.
export function assertFailure(error: unknown, asserts: readonly string[]): string | null {
  const e = error as { message?: string; errcode?: number; cause?: { message?: string } };
  const message = e.cause?.message ?? e.message ?? "";
  const isTrigger = e.errcode === 1811 || message.includes("SQLITE_CONSTRAINT_TRIGGER");
  if (!isTrigger) return null;
  const body = message.replace(/^D1_ERROR:\s*/, "");
  for (const name of asserts) {
    if (body === name || body.startsWith(`${name}:`)) return name;
  }
  return null;
}

// JSON columns arrive as text from the engine. The generated meta says which.
export function parseJson<R extends Record<string, unknown>>(rows: readonly Record<string, unknown>[], json: readonly string[]): R[] {
  if (json.length === 0) return rows as R[];
  return rows.map((row) => {
    const out = { ...row };
    for (const c of json) {
      const v = out[c];
      if (typeof v === "string") out[c] = JSON.parse(v);
    }
    return out as R;
  });
}

// The message of an engine error without the D1 prefix and the extended
// result code suffix that D1 and a Durable Object append.
function bareMessage(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } };
  const message = e.cause?.message ?? e.message ?? "";
  return message.replace(/^D1_ERROR:\s*/, "").replace(/:\s*SQLITE_CONSTRAINT(?:_[A-Z]+)?\s*(?:\(extended:[^)]*\))?\s*$/, "");
}

// A constraint failure as a value, when the error is one. The text formats
// are the same on node:sqlite, D1, and a Durable Object.
export function constraintFailure(error: unknown): ConstraintFailure | null {
  const m = bareMessage(error);
  let match: RegExpExecArray | null;
  if ((match = /^UNIQUE constraint failed: (.+)$/.exec(m))) {
    const refs = match[1]!.split(",").map((r) => r.trim().split("."));
    const table = refs[0]?.[0] ?? "";
    return { kind: "unique", table, columns: refs.map((r) => r[1] ?? r[0] ?? "") };
  }
  if ((match = /^CHECK constraint failed: (.+)$/.exec(m))) return { kind: "check", constraint: match[1]! };
  if ((match = /^NOT NULL constraint failed: ([^.]+)\.(.+)$/.exec(m))) return { kind: "not_null", table: match[1]!, column: match[2]! };
  if (/^FOREIGN KEY constraint failed$/.test(m)) return { kind: "foreign_key" };
  if ((match = /^cannot store (\w+) value in (\w+) column ([^.]+)\.(.+)$/.exec(m))) {
    return { kind: "datatype", table: match[3]!, column: match[4]!, stored: match[1]!, declared: match[2]! };
  }
  return null;
}

// Time one call and report it to the observe hook.
export async function observed<T>(hook: ((event: { kind: "query" | "batch" | "command"; name: string; ms: number; outcome: string }) => void) | undefined, kind: "query" | "batch" | "command", name: string, body: () => Promise<T>, outcomeOf: (value: T) => string): Promise<T> {
  if (!hook) return body();
  const start = performance.now();
  try {
    const value = await body();
    hook({ kind, name, ms: performance.now() - start, outcome: outcomeOf(value) });
    return value;
  } catch (e) {
    hook({ kind, name, ms: performance.now() - start, outcome: "error" });
    throw e;
  }
}

export function outcomeOf(result: { ok: boolean; kind?: string; assert?: string }): string {
  if (result.ok) return "ok";
  return result.kind === "assert" ? `assert:${result.assert}` : (result.kind ?? "error");
}
