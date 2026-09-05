// Can a generated value carry the type map so that queries(generated, {...})
// infers G, and a changed SQL string fails at the call site?
type SqlValue = string | number | bigint | null | Uint8Array;
type Entry = { params: Record<string, SqlValue>; row: Record<string, unknown> };
type GeneratedMap = Record<string, Entry>;
type Meta<G extends GeneratedMap> = { [K in keyof G]: { params: readonly (keyof G[K]["params"] & string)[]; json: readonly (keyof G[K]["row"] & string)[] } } & { readonly __types?: G };

type Query<S extends string, E extends Entry> = { sql: S; readonly __entry?: E };
declare function queries<G extends GeneratedMap, const Q extends Record<string, keyof G & string>>(
  generated: Meta<G>, q: Q,
): { [K in keyof Q]: Query<Q[K], G[Q[K]]> };
type Row<Q> = Q extends Query<string, infer E> ? E["row"] : never;
type Params<Q> = Q extends Query<string, infer E> ? E["params"] : never;

// --- the generated file ---
type OrdersId = string & { readonly __brand: "orders" };
type Generated = {
  "select id, status from orders where id = :id": { params: { id: OrdersId }; row: { id: OrdersId; status: "draft" | "confirmed" } };
  "select count(*) as n from orders": { params: {}; row: { n: number } };
};
const generated: Meta<Generated> = {
  "select id, status from orders where id = :id": { params: ["id"], json: [] },
  "select count(*) as n from orders": { params: [], json: [] },
};

// --- user code ---
const q = queries(generated, {
  byId: "select id, status from orders where id = :id",
  count: "select count(*) as n from orders",
});
const row: Row<typeof q.byId> = { id: "o1" as OrdersId, status: "draft" };
const p: Params<typeof q.byId> = { id: "o1" as OrdersId };
const n: Row<typeof q.count>["n"] = 3;
export { row, p, n };
