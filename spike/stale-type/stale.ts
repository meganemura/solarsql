// Spike: generated row types are keyed by the SQL text itself. A query whose
// text changed has no entry, so tsc fails until the types are regenerated.
// This file compiles. spike/stale-type/stale.ts is the same file after an
// edit to the SQL and must fail to compile.

// --- what a generator would emit (from the engine facts, see 03b) ---
type Generated = {
  "select id, status from orders where id = ?": {
    params: [id: string];
    row: { id: string; status: "draft" | "confirmed" };
  };
  "select o.id, count(l.id) as n from orders o left join order_lines l on l.order_id = o.id group by o.id": {
    params: [];
    row: { id: string; n: unknown };
  };
};

// --- the library surface ---
type Catalog = { [K in keyof Generated]: K };
declare function query<S extends keyof Generated>(
  sql: S,
  ...params: Generated[S]["params"]
): Generated[S]["row"][];

// --- user code ---
const rows = query("select id, status, note from orders where id = ?", "o1");
const first = rows[0];
if (first) {
  const status: "draft" | "confirmed" = first.status;
  console.log(status);
}
export type { Catalog };
