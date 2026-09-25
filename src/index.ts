// solarsql: a typed SQL layer for SQLite on Cloudflare, written for a coding
// agent that reads one module at a time.
//
// Responsibility: the values a module file exports (tables, indexes, queries,
// commands, asserts, the project configuration) and the types that connect
// them to the file that `solarsql build` generates.
// Boundary: nothing here talks to a database. The adapters in ./d1.ts and
// ./durable.ts execute queries and commands. Nothing here reads SQL text;
// the build step does that.

import { uuidV7 } from "./runtime/id.ts";
export { failureClass } from "./runtime/failure.ts";
export type { FailureClass } from "./runtime/failure.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;
// JSONB storage can decode to any JSON shape; binary storage is not the
// representation returned by a JSON constructor.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

declare const idBrand: unique symbol;

// The id of a row of table T. A value of another table's id does not fit.
export type Id<T extends string> = string & { readonly [idBrand]: T };

// A new id for a row: a UUID version 7, so ids made later sort later
// (ADR 0016). `newId<OrdersId>()` is the id of an order that does not exist
// yet, ready for the first statement of a plan.
export function newId<I extends Id<string>>(): I {
  return uuidV7() as unknown as I;
}

// One entry of the generated map: the parameters a statement takes and the
// row it returns. A statement that returns no rows has an empty row type.
// `returning` marks a DELETE ... RETURNING plan item (ADR 0136): the build
// sets it to the literal `true` only there, so PlanRows below can find a
// command's row source by type alone, in place of `returns`. Every other
// entry omits it, which `unknown extends ...` below reads the same as
// `false`.
export type Entry = {
  params: Record<string, unknown>;
  row: Record<string, unknown>;
  returning?: true;
};

export type GeneratedMap = Record<string, Entry>;

// The value the generated file exports. Per statement: the parameter names
// in the order SQLite numbers them, the parameters the adapter encodes as
// JSON text (arrays for json_each), the columns that hold JSON text, and
// the tables of the schema the statement reads, sorted (ADR 0041), for a
// caller that routes or invalidates by table. `returning`, present only on
// a DELETE ... RETURNING entry (ADR 0136), lets commands() find a command's
// row source at construction without reading SQL text, the way `json`
// already lets an adapter find a JSON column without reading it.
// The optional `__types` member carries the type map for inference only and
// never holds a value.
export type Meta<G extends GeneratedMap> = {
  [K in keyof G]: {
    params: readonly (keyof G[K]["params"] & string)[];
    encode: readonly (keyof G[K]["params"] & string)[];
    json: readonly (keyof G[K]["row"] & string)[];
    reads: readonly string[];
    returning?: true;
  };
} & { readonly __types?: G };

export type StatementMeta = { params: readonly string[]; encode: readonly string[]; json: readonly string[]; reads: readonly string[]; returning?: true };

// --- schema -------------------------------------------------------------------

export type Table = { kind: "table"; sql: string };
export type Index = { kind: "index"; sql: string };
export type View = { kind: "view"; sql: string };
export type Trigger = { kind: "trigger"; sql: string };
export type Search = { kind: "search"; sql: string };

// A table of this module. `sql` is one CREATE TABLE statement. The leading
// `--` comment lines are the documentation of the table.
export function table<const S extends string>(sql: S): Table & { sql: S } {
  return { kind: "table", sql };
}

// An index on a table of this module. `sql` is one CREATE INDEX statement.
export function index<const S extends string>(sql: S): Index & { sql: S } {
  return { kind: "index", sql };
}

// A view of this module. `sql` is one CREATE VIEW statement. A query reads
// it like a table, and the boundary check sees the tables under it.
export function view<const S extends string>(sql: S): View & { sql: S } {
  return { kind: "view", sql };
}

// A trigger on a table of this module. `sql` is one CREATE TRIGGER
// statement. Its body may touch the tables of this module only.
export function trigger<const S extends string>(sql: S): Trigger & { sql: S } {
  return { kind: "trigger", sql };
}

// A full-text search table of this module: one CREATE VIRTUAL TABLE ...
// USING fts5 statement. Its columns are text, `rank` is a number, and
// `where <table> match :q` takes a string. Triggers keep it in step with
// the table it indexes.
export function search<const S extends string>(sql: S): Search & { sql: S } {
  return { kind: "search", sql };
}

// --- queries ------------------------------------------------------------------

export type Query<S extends string, E extends Entry> = {
  kind: "query";
  // The key in the catalog, for the observe hook.
  name: string;
  sql: S;
  meta: StatementMeta;
  readonly __entry?: E;
};

export type Queries<G extends GeneratedMap, Q extends Record<string, keyof G & string>> = {
  kind: "queries";
  entries: { [K in keyof Q]: Query<Q[K], G[Q[K]]> };
} & { [K in keyof Q]: Query<Q[K], G[Q[K]]> };

// A constraint of the form `Record<string, keyof G & string>` names the
// union of every key of the generated map as the expected type of a stale
// literal: tsc has no key to point at, so the message repeats the whole
// catalog (measured on 2026-09-19; see ADR 0126). Checking membership per
// key in a mapped type instead makes the expected type at a stale key the
// remedy sentence, not the union.
type Known<G extends GeneratedMap, Q extends Record<string, string>> = {
  [K in keyof Q]: Q[K] extends keyof G ? Q[K] : "not in solarsql.generated.ts: run npx solarsql build";
};

// The read API of a module: one name per SQL string. Every string must be a
// key of the generated map, so a changed string fails to compile until
// `solarsql build` runs again.
// Two overloads, not one generic signature, because a single signature that
// both infers `Q`'s literal types from `q` and checks each of them against
// `Known` sent every property to the remedy message, not only the stale one
// (measured on 2026-09-19): TS solves `Q` and its own bound together, and
// the two constraints fight. The first overload keeps the exact inference a
// correct catalog had before; the second is never satisfied by a correct
// catalog, so it only fires, and reports, when the first one fails.
export function queries<G extends GeneratedMap, const Q extends Record<string, keyof G & string>>(generated: Meta<G>, q: Q): Queries<G, Q>;
export function queries<G extends GeneratedMap, const Q extends Record<string, string>>(generated: Meta<G>, q: Known<G, Q>): never;
export function queries<G extends GeneratedMap, const Q extends Record<string, string>>(generated: Meta<G>, q: Q): Queries<G, Q & Record<string, keyof G & string>> {
  const entries = {} as Record<string, Query<string, Entry>>;
  for (const [name, sql] of Object.entries(q)) {
    entries[name] = { kind: "query", name, sql, meta: metaOf(generated, sql) };
  }
  return { kind: "queries", entries, ...entries } as unknown as Queries<G, Q & Record<string, keyof G & string>>;
}

// --- commands -----------------------------------------------------------------

export type Assert<N extends string, P extends string> = { kind: "assert"; name: N; predicate: P };

// A rule that spans rows. The predicate is SQL that yields 0 or 1. When it
// yields 0 the whole command rolls back and the result names the assert.
export function assert<const N extends string, const P extends string>(name: N, predicate: P): Assert<N, P> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`assert name must match [a-z_][a-z0-9_]*: ${name}`);
  return { kind: "assert", name, predicate };
}

export type PlanItem = string | Assert<string, string>;

// A plan item declared in a module's own commands(): a statement key or an
// assert, plus (ADR 0127) another module's exported command, included
// whole. commands() flattens an included item at construction, so a
// Command's own `plan` (below) only ever holds PlanItem: an adapter and the
// build's per-statement checks never see a Command in a plan.
// The included command's own generated map and plan shape are `any` here,
// not `G`/`PlanShape<G>`: those name the *including* module's own
// generated map, and an included command's real generic arguments (its own
// module's map and shape) are recovered per use-site below, by `infer`
// against the literal type the caller's object carries -- naming them
// `GeneratedMap`/`PlanShape<GeneratedMap>` here would make this alias its
// own unbounded expansion (Command's `P` extends PlanShape<G>, whose `plan`
// holds PlanShapeItem<G> again), which tsc reports as excessively deep
// (measured on this repository's own build).
export type PlanShapeItem<G extends GeneratedMap> = (keyof G & string) | Assert<string, keyof G & string> | Command<any, any>;

export type PlanShape<G extends GeneratedMap> = {
  plan: readonly PlanShapeItem<G>[];
  returns?: keyof G & string;
};

type ItemSql<I> = I extends Assert<string, infer P> ? P : I extends string ? I : never;
type EntryParams<G extends GeneratedMap, S> = S extends keyof G ? G[S]["params"] : {};
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

// An included command contributes the parameters of its own plan (ADR
// 0127); a statement key or an assert contributes the parameters of that
// one statement, the rule a plan already had.
// This reads the phantom `__params` field a `Command<G2, P2>` already
// carries, computed once where that command was declared, instead of
// re-deriving `PlanParams<G2, P2>` here through `I extends Command<infer
// G2, infer P2>`: that inference pattern, applied to a generic, unresolved
// plan-item type, forced tsc to expand `PlanParams` through the `Command<
// any, any>` member `PlanShapeItem` admits for every G, with no G,P ever
// narrow enough to ground the recursion, and it reported the whole file
// "excessively deep" (measured on this repository's own build, in
// `Database.run`'s wide `Command<GeneratedMap, PlanShape<GeneratedMap>>>`
// bound). Reading a field is a plain property lookup, not a fresh generic
// instantiation, so it does not re-trigger that expansion.
type ItemParams<G extends GeneratedMap, I> = I extends { __params?: infer PP } ? (unknown extends PP ? EntryParams<G, ItemSql<I>> : PP) : EntryParams<G, ItemSql<I>>;

// The parameters of a command: every parameter of every statement, assert,
// included command, and the returns query, merged into one object.
export type PlanParams<G extends GeneratedMap, P extends PlanShape<G>> = Simplify<
  UnionToIntersection<ItemParams<G, P["plan"][number]> | EntryParams<G, P["returns"]>>
>;
// The key of the plan's own DELETE ... RETURNING item, when it has one
// (ADR 0136). Only a plain string plan item can match: `PlanItemSql` maps
// an included Command to `never`, the same "included item contributes
// nothing of its own" rule ItemParams above already follows for `__params`,
// so an included command's own row source never competes with the
// including command's `returns` or its own row-source item.
type PlanItemSql<I> = I extends string ? I : never;
type ReturningKey<G extends GeneratedMap, Items> = Items extends infer I ? (PlanItemSql<I> extends infer K extends keyof G ? (G[K] extends { returning: true } ? K : never) : never) : never;
export type PlanRows<G extends GeneratedMap, P extends PlanShape<G>> = P["returns"] extends keyof G
  ? G[P["returns"]]["row"]
  : ReturningKey<G, P["plan"][number]> extends infer K extends keyof G ? G[K]["row"] : never;
// An included command's own assert names join the plan's own, the rule ADR
// 0127 gives asserts; a plain statement key contributes none. Reads the
// phantom `__asserts` field for the same reason ItemParams reads `__params`
// above.
type ItemAssertNames<I> = I extends { __asserts?: infer AA } ? (unknown extends AA ? (I extends Assert<infer N, string> ? N : never) : AA) : (I extends Assert<infer N, string> ? N : never);
export type PlanAsserts<P extends { plan: readonly unknown[] }> = ItemAssertNames<P["plan"][number]>;

// The item index range (in the flattened `plan`, `to` exclusive) an
// included command's own items landed at, for `inspect`'s provenance
// display. `module` is filled in by the build, which is the only side that
// knows which module owns a command; the runtime never sets it.
// `nested` is true when the included command's own plan already included
// another command: the build refuses that (a range's statements would then
// belong to more than one owner), so it needs to see this flag without
// re-deriving it from the flattened plan, which no longer distinguishes a
// nested include's items from the plain statements around them.
export type PlanInclusion = { name: string; module?: string; from: number; to: number; nested?: boolean };

export type Command<G extends GeneratedMap, P extends PlanShape<G>> = {
  kind: "command";
  name: string;
  plan: readonly PlanItem[];
  returns: string | null;
  meta: { statements: readonly StatementMeta[]; returns: StatementMeta | null; asserts: readonly string[] };
  included: readonly PlanInclusion[];
  // The index into `plan`/`meta.statements` of this command's own DELETE
  // ... RETURNING item, when it has one and `returns` does not (ADR 0136).
  // null when the command has no row source, or when `returns` is the row
  // source instead. An adapter reads rows from this item's own reply in
  // place of running `returns`. Only a plain, non-included item of this
  // command's own plan is ever a candidate: an included command's row
  // source is dropped, the same rule ADR 0127 gives an included `returns`.
  returningIndex: number | null;
  readonly __generated?: G;
  readonly __plan?: P;
  // Computed once, here, for a command included in another module's plan
  // (ADR 0127) to contribute to that plan without ItemParams/ItemAssertNames
  // re-deriving them (see the comment on ItemParams above).
  readonly __params?: PlanParams<G, P>;
  readonly __asserts?: PlanAsserts<P>;
};

export type Commands<G extends GeneratedMap, C extends Record<string, PlanShape<G>>> = {
  kind: "commands";
  entries: { [K in keyof C]: Command<G, C[K]> };
} & { [K in keyof C]: Command<G, C[K]> };

function isIncludedCommand(item: unknown): item is Command<any, any> {
  return !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "command";
}

// The write API of a module: one verb per plan. A plan is a list of SQL
// strings, asserts, and (ADR 0127) other modules' commands, that runs as
// one D1 batch or one Durable Object transaction. `returns` is a query
// whose rows the command returns.
// An included command is expanded here, at construction: its own `plan`
// items and `meta.statements` are spliced in place, verbatim (they carry
// their own meta already, computed by the owner's own `commands()` call,
// so this module's `generated` map, which lacks those keys, never has to
// answer for them); its `returns` is dropped, since only the outer
// command's `returns` runs. `included` records the item range each
// included command landed at, for `inspect`.
export function commands<G extends GeneratedMap, const C extends Record<string, PlanShape<G>>>(generated: Meta<G>, c: C): Commands<G, C> {
  const entries = {} as Record<string, Command<G, PlanShape<G>>>;
  for (const [name, shape] of Object.entries(c)) {
    const rawPlan = shape.plan as readonly (PlanItem | Command<any, any>)[];
    const plan: PlanItem[] = [];
    const statements: StatementMeta[] = [];
    const asserts: string[] = [];
    const included: PlanInclusion[] = [];
    // Set only from a plain item of this command's own plan (never from an
    // included command's own items, spliced in above): ADR 0136 gives an
    // included row-source item the same treatment ADR 0127 already gives
    // an included `returns`, dropped rather than surfaced here. The build
    // refuses a command with more than one candidate, so the first one
    // found is the only one there is.
    let returningIndex: number | null = null;
    for (const item of rawPlan) {
      if (isIncludedCommand(item)) {
        const from = plan.length;
        plan.push(...item.plan);
        statements.push(...item.meta.statements);
        asserts.push(...item.meta.asserts);
        included.push({ name: item.name, from, to: plan.length, ...(item.included.length > 0 ? { nested: true } : {}) });
        continue;
      }
      const meta = metaOf(generated, typeof item === "string" ? item : item.predicate);
      if (meta.returning && returningIndex === null) returningIndex = plan.length;
      plan.push(item);
      statements.push(meta);
      if (typeof item !== "string") asserts.push(item.name);
    }
    entries[name] = {
      kind: "command",
      name,
      plan,
      returns: shape.returns ?? null,
      meta: { statements, returns: shape.returns ? metaOf(generated, shape.returns) : null, asserts },
      included,
      returningIndex: shape.returns ? null : returningIndex,
    };
  }
  return { kind: "commands", entries, ...entries } as unknown as Commands<G, C>;
}

// A constraint of the DDL that a statement of the plan violated. The adapter
// returns this value when the engine message identifies its target without
// ambiguity. It preserves other engine errors as thrown values.
export type ConstraintFailure =
  | { kind: "unique"; table: string; columns: string[] }
  | { kind: "unique_index"; index: string }
  | { kind: "check"; constraint: string }
  | { kind: "not_null"; table: string; column: string }
  | { kind: "foreign_key" }
  | { kind: "datatype"; table: string; column: string; stored: string; declared: string };

// The result of a command. An assert that yields 0 and a constraint that
// rejects a row are normal outcomes, and both arrive as values with one
// discriminant. Every other engine error is thrown. `changes` is the rows
// the plan changed, as D1 counts them (ADR 0042).
export type CommandResult<C> = C extends Command<infer G, infer P>
  ? { ok: true; rows: PlanRows<G, P>[]; changes: number } | { ok: false; kind: "assert"; assert: PlanAsserts<P> } | ({ ok: false } & ConstraintFailure)
  : never;

// What the observe hook of an adapter receives after each query, batch of
// queries, or command. A batch is named by its queries, joined with "+".
// rows_read and rows_written, under the names D1 uses, since both engines
// bill on them (a Durable Object's SQL cursor reports them too, confirmed
// against Miniflare). A command or a batch sums the rows of its statements.
// duration is D1's own server-side timing; a Durable Object has no
// corresponding value, so duration stays optional and is left out of its
// meta rather than reported as a false 0. node:sqlite reports no meta at
// all, and the field is absent.
export type EngineMeta = { rows_read: number; rows_written: number; duration?: number; served_by_region?: string; served_by_primary?: boolean };

// Where an unclassified error or a constraint failure happened (ADR 0137):
// a plan item's 1-based position and the plan's total, or the returns
// clause. `sql` is the catalog text, with no bound values; a failing
// assert's `sql` is its predicate (the catalog names it by that text, not
// by the text the adapter composes at run time, which now carries a bound
// invocation token rather than one written into it). `included` names an
// including command's included range (ADR 0127) when the position falls
// inside one. D1 never sets this field: a failed batch names no index, and
// D1's own engine errors carry nothing an adapter could attribute to one
// statement.
export type At = { position: number; of: number; sql: string; included?: string } | { returns: true; sql: string };

// The rows_read/rows_written (and, on D1, duration) of one plan item, in
// expanded-plan order, then one for `returns` when the command has one
// (ADR 0039's 2026-09-25 section). Guard cleanup and a Durable Object's
// total_changes() probes are not plan items and get no entry. Present only
// when every entry carries both counters, so index i always means
// position i + 1.
export type StatementRow = { rows_read: number; rows_written: number; duration?: number };

export type Observed = {
  kind: "query" | "batch" | "command";
  name: string;
  ms: number;
  // "ok", "assert:<name>", a constraint kind, or "error" when thrown.
  outcome: string;
  meta?: EngineMeta;
  at?: At;
  statements?: readonly StatementRow[];
};

export type AdapterOptions = {
  // Telemetry failures cannot change a committed operation's outcome.
  observe?: (event: Observed) => void;
};

export type Row<Q> = Q extends Query<string, infer E> ? E["row"] : Q extends Command<infer G, infer P> ? PlanRows<G, P> : never;
export type Params<Q> = Q extends Query<string, infer E> ? E["params"] : Q extends Command<infer G, infer P> ? PlanParams<G, P> : never;

// A parameter object is optional when the statement takes no parameters.
export type ParamsArg<Q> = {} extends Params<Q> ? [params?: Params<Q>] : [params: Params<Q>];

// One query with its parameters, for a batch. `read()` checks the
// parameters against the query, so the batch itself needs no such check.
export type Read<Q extends Query<string, Entry>> = { kind: "read"; query: Q; params: Record<string, unknown> };

export function read<Q extends Query<string, Entry>>(query: Q, ...params: ParamsArg<Q>): Read<Q> {
  return { kind: "read", query, params: (params[0] ?? {}) as Record<string, unknown> };
}

// The rows of each read of a batch, in the same order.
export type BatchRows<R extends readonly Read<Query<string, Entry>>[]> = { [K in keyof R]: R[K] extends Read<infer Q> ? Row<Q>[] : never };

// What an adapter offers. The same verbs run on D1, on a Durable Object,
// and on node:sqlite, so a module written for one runs on the others.
// `batch` runs several queries in one D1 round trip; the other adapters
// run them in order.
export type Database = {
  all<Q extends Query<string, Entry>>(query: Q, ...params: ParamsArg<Q>): Promise<Row<Q>[]>;
  first<Q extends Query<string, Entry>>(query: Q, ...params: ParamsArg<Q>): Promise<Row<Q> | null>;
  batch<const R extends readonly Read<Query<string, Entry>>[]>(reads: R): Promise<BatchRows<R>>;
  run<C extends Command<GeneratedMap, PlanShape<GeneratedMap>>>(command: C, ...params: ParamsArg<C>): Promise<CommandResult<C>>;
};

function metaOf(generated: Meta<GeneratedMap>, sql: string): StatementMeta {
  const m = (generated as Record<string, StatementMeta | undefined>)[sql];
  return m ?? { params: [], encode: [], json: [], reads: [] };
}

// --- configuration ------------------------------------------------------------

export type ModuleConfig = {
  // The directory of the module, relative to the configuration file.
  dir: string;
  // A module that reads every table, for reports. Default false.
  readsAll?: boolean;
};

export type Config = {
  modules: readonly (string | ModuleConfig)[];
  // The directory of the migration files, relative to the configuration file.
  migrations: string;
  // The import specifier of solarsql in generated files. Default "solarsql".
  library?: string;
};

export function config(c: Config): Config {
  return c;
}
