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

export type SqlValue = string | number | bigint | null | Uint8Array;

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
export type Entry = {
  params: Record<string, unknown>;
  row: Record<string, unknown>;
};

export type GeneratedMap = Record<string, Entry>;

// The value the generated file exports. Per statement: the parameter names
// in the order SQLite numbers them, the parameters the adapter encodes as
// JSON text (arrays for json_each), and the columns that hold JSON text.
// The optional `__types` member carries the type map for inference only and
// never holds a value.
export type Meta<G extends GeneratedMap> = {
  [K in keyof G]: {
    params: readonly (keyof G[K]["params"] & string)[];
    encode: readonly (keyof G[K]["params"] & string)[];
    json: readonly (keyof G[K]["row"] & string)[];
  };
} & { readonly __types?: G };

export type StatementMeta = { params: readonly string[]; encode: readonly string[]; json: readonly string[] };

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

// The read API of a module: one name per SQL string. Every string must be a
// key of the generated map, so a changed string fails to compile until
// `solarsql build` runs again.
export function queries<G extends GeneratedMap, const Q extends Record<string, keyof G & string>>(generated: Meta<G>, q: Q): Queries<G, Q> {
  const entries = {} as Record<string, Query<string, Entry>>;
  for (const [name, sql] of Object.entries(q)) {
    entries[name] = { kind: "query", name, sql, meta: metaOf(generated, sql) };
  }
  return { kind: "queries", entries, ...entries } as unknown as Queries<G, Q>;
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

export type PlanShape<G extends GeneratedMap> = {
  plan: readonly (keyof G & string | Assert<string, keyof G & string>)[];
  returns?: keyof G & string;
};

type ItemSql<I> = I extends Assert<string, infer P> ? P : I extends string ? I : never;
type EntryParams<G extends GeneratedMap, S> = S extends keyof G ? G[S]["params"] : {};
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

// The parameters of a command: every parameter of every statement, assert,
// and the returns query, merged into one object.
export type PlanParams<G extends GeneratedMap, P extends PlanShape<G>> = Simplify<
  UnionToIntersection<EntryParams<G, ItemSql<P["plan"][number]>> | EntryParams<G, P["returns"]>>
>;
export type PlanRows<G extends GeneratedMap, P extends PlanShape<G>> = P["returns"] extends keyof G ? G[P["returns"]]["row"] : never;
export type PlanAsserts<P extends { plan: readonly unknown[] }> = Extract<P["plan"][number], Assert<string, string>>["name"];

export type Command<G extends GeneratedMap, P extends PlanShape<G>> = {
  kind: "command";
  name: string;
  plan: readonly PlanItem[];
  returns: string | null;
  meta: { statements: readonly StatementMeta[]; returns: StatementMeta | null; asserts: readonly string[] };
  readonly __generated?: G;
  readonly __plan?: P;
};

export type Commands<G extends GeneratedMap, C extends Record<string, PlanShape<G>>> = {
  kind: "commands";
  entries: { [K in keyof C]: Command<G, C[K]> };
} & { [K in keyof C]: Command<G, C[K]> };

// The write API of a module: one verb per plan. A plan is a list of SQL
// strings and asserts that runs as one D1 batch or one Durable Object
// transaction. `returns` is a query whose rows the command returns.
export function commands<G extends GeneratedMap, const C extends Record<string, PlanShape<G>>>(generated: Meta<G>, c: C): Commands<G, C> {
  const entries = {} as Record<string, Command<G, PlanShape<G>>>;
  for (const [name, shape] of Object.entries(c)) {
    const plan = shape.plan as readonly PlanItem[];
    entries[name] = {
      kind: "command",
      name,
      plan,
      returns: shape.returns ?? null,
      meta: {
        statements: plan.map((item) => metaOf(generated, typeof item === "string" ? item : item.predicate)),
        returns: shape.returns ? metaOf(generated, shape.returns) : null,
        asserts: plan.filter((item): item is Assert<string, string> => typeof item !== "string").map((a) => a.name),
      },
    };
  }
  return { kind: "commands", entries, ...entries } as unknown as Commands<G, C>;
}

// A constraint of the DDL that a statement of the plan violated. The engine
// reports it, and the adapter turns the message into this value.
export type ConstraintFailure =
  | { kind: "unique"; table: string; columns: string[] }
  | { kind: "check"; constraint: string }
  | { kind: "not_null"; table: string; column: string }
  | { kind: "foreign_key" }
  | { kind: "datatype"; table: string; column: string; stored: string; declared: string };

// The result of a command. An assert that yields 0 and a constraint that
// rejects a row are normal outcomes, and both arrive as values with one
// discriminant. Every other engine error is thrown.
export type CommandResult<C> = C extends Command<infer G, infer P>
  ? { ok: true; rows: PlanRows<G, P>[] } | { ok: false; kind: "assert"; assert: PlanAsserts<P> } | ({ ok: false } & ConstraintFailure)
  : never;

// What the observe hook of an adapter receives after each query, batch of
// queries, or command. A batch is named by its queries, joined with "+".
// What D1 reports about a call, under the names D1 uses: the rows it read
// and wrote (D1 bills on them), its own duration in milliseconds, and where
// it ran. A command or a batch sums the rows and the duration of its
// statements. A Durable Object and node:sqlite report none, and the field
// is absent.
export type EngineMeta = { rows_read: number; rows_written: number; duration: number; served_by_region?: string; served_by_primary?: boolean };

export type Observed = {
  kind: "query" | "batch" | "command";
  name: string;
  ms: number;
  // "ok", "assert:<name>", a constraint kind, or "error" when thrown.
  outcome: string;
  meta?: EngineMeta;
};

export type AdapterOptions = {
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
  return m ?? { params: [], encode: [], json: [] };
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
