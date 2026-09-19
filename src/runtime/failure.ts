// Responsibility: sort a thrown, unclassified engine error into a retry
// decision, from the error text D1 and a Durable Object are documented to
// throw. Constraint and assert failures already arrive as values (ADR 0082,
// constraintFailure() and assertFailure() in this directory's plan.ts);
// this module covers what is left over, the errors those two do not parse.
// Boundary: no retry, no sleep, no adapter call. This module reads a
// message; it never decides how long to wait or how many times to try
// (ADR 0030 keeps that in the caller). It never changes the observe hook's
// outcome string.
import { bareMessage, constraintFailure, errorDetails } from "./plan.ts";

export type FailureClass =
  | { kind: "transient"; outcome: "not_applied" | "unknown"; reason: string }
  | { kind: "permanent"; reason: string }
  | { kind: "unclassified" };

type RuleClass = { kind: "transient"; outcome: "not_applied" | "unknown" } | { kind: "permanent" };

type Rule = { reason: string; test: (message: string) => boolean; class: RuleClass };

const NOT_APPLIED: RuleClass = { kind: "transient", outcome: "not_applied" };
const UNKNOWN: RuleClass = { kind: "transient", outcome: "unknown" };
const PERMANENT: RuleClass = { kind: "permanent" };

// A known SQLite constraint text (the same five shapes constraintFailure()
// parses, plus the datatype-mismatch shape) that constraintFailure() could
// still fail to resolve to a target, for example an unusual quoting
// constraintFailure()'s own patterns do not cover.
const CONSTRAINT_LOOKING = /constraint failed|^cannot store \w+ value in \w+ column/;

// bareMessage() (src/runtime/plan.ts) already strips this same wrapper
// text before this module ever sees it, so its presence has to be
// checked here against the raw message instead; this regex duplicates
// that one, because plan.ts exports only bareMessage() and errorDetails()
// (its own scope in this task), not the wrapper pattern itself.
const RESET_WRAPPER = /^Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated:\s*/;

// Each test runs against bareMessage(error): the D1_ERROR prefix, the
// Durable Object reset-and-rolled-back wrapper, and the trailing extended
// result code are already gone, so a rule matches the text the two
// platforms' own docs quote.
const RULES: readonly Rule[] = [
  // A Durable Object refuses the request before it reaches storage: the
  // page names an `.overloaded` property on the exception so an
  // application can tell this apart from other errors and back off, and
  // explicitly warns that this property "can be used to avoid retrying
  // overloaded operations" outright. not_applied here names only what
  // this module can confirm (the request never ran); it is not this
  // module's advice to retry immediately.
  // https://developers.cloudflare.com/durable-objects/observability/troubleshooting/ (checked 2026-09-19, page dated 2026-05-15): "Durable Object is overloaded." (four variants share this prefix).
  { reason: "do_overloaded", test: (m) => m.startsWith("Durable Object is overloaded."), class: NOT_APPLIED },
  // Same page: a stub lookup was refused for account-wide load, "usually
  // cached", so retrying after a short wait is safe; the request did not
  // reach an object.
  // https://developers.cloudflare.com/durable-objects/observability/troubleshooting/ (checked 2026-09-19, page dated 2026-05-15).
  { reason: "do_account_overloaded", test: (m) => m === "Your account is generating too much load on Durable Objects. Please back off and try again later.", class: NOT_APPLIED },
  // Same page, for storage calls specifically: back off, and prefer a
  // batched get(keys). The rejection happens before the call starts.
  // https://developers.cloudflare.com/durable-objects/observability/troubleshooting/ (checked 2026-09-19, page dated 2026-05-15).
  { reason: "do_storage_concurrency", test: (m) => m === "Your account is doing too many concurrent storage operations. Please back off and try again later.", class: NOT_APPLIED },
  // D1's queue refused the batch before running it; the page's own
  // "Recommended action" for both variants below is to send fewer or
  // cheaper requests, not "retry", so not_applied names only that the
  // batch never ran, not that an immediate retry is the fix.
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11): "D1 DB is overloaded. Requests queued for too long." and "D1 DB is overloaded. Too many requests queued." share this prefix.
  { reason: "d1_overloaded", test: (m) => m.startsWith("D1 DB is overloaded."), class: NOT_APPLIED },
  // The query never reached the Durable Object behind the database.
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11): "Cannot resolve D1 DB due to transient issue on remote node." — "Retry the operation."
  { reason: "d1_remote_transient", test: (m) => m === "Cannot resolve D1 DB due to transient issue on remote node.", class: NOT_APPLIED },

  // The reply was lost; a write may already have run. The Workers error
  // table calls this a plain "retry it", but a write is not idempotent
  // by default (running.md), so this module reports the outcome as
  // unknown and leaves the choice to reconcile or retry to the caller.
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11): "Network connection lost."
  // https://developers.cloudflare.com/workers/observability/errors/ (checked 2026-09-19): "Network connection lost" (no trailing period on this page; startsWith covers both).
  { reason: "network_lost", test: (m) => m.startsWith("Network connection lost"), class: UNKNOWN },
  // The page does not say whether the primary had already applied the
  // statement when the replica lost contact with it.
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11): "Replica disconnected from primary."
  { reason: "d1_replica_disconnected", test: (m) => m === "Replica disconnected from primary.", class: UNKNOWN },
  // A deploy or an internal restart can land mid-request on either
  // platform; the object is gone, but the statement it was running is not
  // confirmed to have run or not.
  // https://developers.cloudflare.com/durable-objects/observability/troubleshooting/ and
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (both checked 2026-09-19): "Durable Object reset because its code was updated." / "D1 DB reset because its code was updated."
  { reason: "reset_code_updated", test: (m) => m.includes("reset because its code was updated"), class: UNKNOWN },
  // A storage call that ran past its time budget is reset; the DO page
  // says one specific call (deleteAll()) makes progress and is safe to
  // repeat, which is a reconciliation property this module cannot check
  // from the message alone, so it reports unknown rather than a blanket
  // retry.
  // https://developers.cloudflare.com/durable-objects/observability/troubleshooting/ and
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (both checked 2026-09-19): "... storage operation exceeded timeout which caused object to be reset."
  { reason: "storage_timeout_reset", test: (m) => m.includes("storage operation exceeded timeout which caused object to be reset"), class: UNKNOWN },
  // The object failed to start or crashed mid-flight; the page says
  // "Retry the operation" but not whether a statement already sent had
  // run first.
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11): "Internal error while starting up D1 DB storage caused object to be reset." / "Internal error in D1 DB storage caused object to be reset."
  { reason: "d1_internal_reset", test: (m) => m === "Internal error while starting up D1 DB storage caused object to be reset." || m === "Internal error in D1 DB storage caused object to be reset.", class: UNKNOWN },

  // The engine rejected the SQL text itself; no retry changes that.
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11): the worked example throws `D1_EXEC_ERROR: Error in line 1: ...: sql error: near "INSERTZ": syntax error ...` for a misspelled keyword.
  { reason: "sql_syntax_error", test: (m) => m.includes("D1_EXEC_ERROR") || /sql error: near "/.test(m), class: PERMANENT },
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11): "D1_TYPE_ERROR: Returned when there is a mismatch in the type between a column and a value."
  { reason: "d1_type_error", test: (m) => m.includes("D1_TYPE_ERROR"), class: PERMANENT },
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11): "D1_COLUMN_NOTFOUND: Column not found."
  { reason: "d1_column_notfound", test: (m) => m.includes("D1_COLUMN_NOTFOUND"), class: PERMANENT },
  // A missing table or column is a fixed schema mismatch; node:sqlite, D1,
  // and a Durable Object all pass SQLite's own text through unprefixed
  // (src/runtime/plan.ts's bareMessage() strips only the platform
  // wrappers around it), the same pass-through the debug-d1 page's
  // syntax-error example shows for a different SQLite message
  // ('near "INSERTZ": syntax error'). No fetched page names "no such
  // table" or "no such column" directly; this rule generalizes from that
  // one documented pass-through example plus the engine's own well-known
  // text.
  // https://developers.cloudflare.com/d1/observability/debug-d1/ (checked 2026-09-19, page dated 2026-08-11).
  { reason: "sqlite_no_such", test: (m) => m.startsWith("no such table") || m.startsWith("no such column"), class: PERMANENT },
  // A constraint-shaped message constraintFailure() did not resolve
  // (ADR 0082 declines rather than guesses): the engine still applied a
  // known kind of rule, so it is permanent, not a lost reply. This must
  // run before sqlite_code below: an unresolved "... SQLITE_CONSTRAINT"
  // text would otherwise match the SQLITE_ catch-all and lose its more
  // specific reason.
  { reason: "unresolved_constraint", test: (m) => CONSTRAINT_LOOKING.test(m), class: PERMANENT },
  // The statement could not start because a separate connection already
  // held the lock this one needed; no data was written by this call.
  // This must run before sqlite_code below, since sqlite_code would
  // otherwise also match the SQLITE_BUSY text.
  // https://sqlite.org/rescode.html (checked 2026-09-19): "SQLITE_BUSY ...
  // the database file could not be written (or in some cases read)
  // because of concurrent activity by some other database connection."
  // "SQLITE_LOCKED ... indicates a conflict within the same database
  // connection." The page also notes SQLITE_BUSY can occur later in a
  // transaction (on a write, or at commit), not only at the start; this
  // module still reports not_applied for the plain, unqualified message,
  // matching the coordinator's classification for this rule.
  { reason: "sqlite_busy", test: (m) => m.includes("SQLITE_BUSY") || m.includes("SQLITE_LOCKED") || m.includes("database is locked"), class: NOT_APPLIED },
  // Any other SQLite extended result code in the text is the engine's own
  // classification. This is a catch-all, not a page citation: none of the
  // five fetched Cloudflare pages lists a SQLITE_ code by name, but
  // src/runtime/plan.ts already depends on this exact string appearing
  // unprefixed ("D1 and a Durable Object report `<name>: SQLITE_CONSTRAINT
  // (extended: SQLITE_CONSTRAINT_TRIGGER)`").
  { reason: "sqlite_code", test: (m) => m.includes("SQLITE_"), class: PERMANENT },
];

// Unknown thrown values, and a message no rule matches, must never throw
// out of this function; a caller in a catch block cannot risk a second
// exception from the classifier itself.
export function failureClass(error: unknown): FailureClass {
  try {
    const raw = errorDetails(error).message;
    if (raw.length === 0) return { kind: "unclassified" };
    const message = bareMessage(error);
    const constraint = constraintFailure(error);

    // A reset that wrapped a constraint violation the parser could not
    // resolve to a target: the wrapper's own text states both the cause
    // ("constraints were violated") and the outcome ("reset and rolled
    // back to its last known good state" -- nothing from this request is
    // applied), so this is a known, permanent SQL error, not a lost
    // reply. What this module cannot name is which constraint.
    if (constraint === null && RESET_WRAPPER.test(raw.replace(/^D1_ERROR:\s*/, ""))) {
      return { kind: "permanent", reason: "unresolved_constraint" };
    }

    // A constraint the parser did resolve is a known, permanent SQL
    // error, whether or not this error also carried a reset wrapper: the
    // wrapper's job is to name a state that was reached, and this parses
    // which one.
    if (constraint !== null) return { kind: "permanent", reason: "resolved_constraint" };

    for (const rule of RULES) {
      if (rule.test(message)) {
        return rule.class.kind === "permanent"
          ? { kind: "permanent", reason: rule.reason }
          : { kind: "transient", outcome: rule.class.outcome, reason: rule.reason };
      }
    }

    return { kind: "unclassified" };
  } catch {
    return { kind: "unclassified" };
  }
}
