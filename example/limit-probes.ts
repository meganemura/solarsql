// Responsibility: the statements that ask D1 or a Durable Object where its
// SQLite limits are (limits.md), and a runner that records "pass" or the
// error text of each. Boundary: no expected values.
export type LimitProbe = { name: string; sql: string; params: unknown[] };
export type ProbeResult = { name: string; result: string };

const union = (n: number) => `select * from (${Array.from({ length: n }, (_, i) => `select ${i}`).join(" union all ")})`;
const coalesce = (n: number) => `select coalesce(${Array.from({ length: n }, () => "null").join(",")})`;
const jsonObject = (pairs: number) => `select json_object(${Array.from({ length: pairs }, (_, i) => `'k${i}',${i}`).join(",")})`;
const chain = (n: number) => `select 1${"+1".repeat(n - 1)}`;
const columns = (n: number) => `select ${Array.from({ length: n }, (_, i) => `1 as c${i}`).join(",")}`;
// Positional: a Durable Object's sql.exec() binds only positional values.
const placeholders = (n: number) => `select ${Array.from({ length: n }, () => "?").join(",")}`;
const padded = (bytes: number) => {
  const prefix = "select 1 as a --";
  return `${prefix} ${"x".repeat(bytes - prefix.length - 1)}`;
};
// Rows of `(0)` reach the VDBE limit while the text stays under 100,000
// bytes. 15,000 numbered rows pass 100,000 bytes, so D1 and a Durable Object
// refuse them for their length first.
const values = (rows: number) => `select * from (values ${Array.from({ length: rows }, () => "(0)").join(",")})`;
// length() keeps the reply small, and zeroblob() checks the value-length
// limit when it builds the value.
const blob = (bytes: number) => `select length(zeroblob(${bytes}))`;

export const LIMIT_PROBES: readonly LimitProbe[] = [
  { name: "5-term UNION ALL", sql: union(5), params: [] },
  { name: "6-term UNION ALL", sql: union(6), params: [] },
  { name: "6-row VALUES", sql: "select * from (values (0),(1),(2),(3),(4),(5))", params: [] },
  { name: "coalesce with 32 arguments", sql: coalesce(32), params: [] },
  { name: "coalesce with 33 arguments", sql: coalesce(33), params: [] },
  { name: "coalesce with 127 arguments", sql: coalesce(127), params: [] },
  { name: "coalesce with 128 arguments", sql: coalesce(128), params: [] },
  { name: "json_object with 17 pairs (34 arguments)", sql: jsonObject(17), params: [] },
  { name: "json_object with 63 pairs (126 arguments)", sql: jsonObject(63), params: [] },
  { name: "100-term addition", sql: chain(100), params: [] },
  { name: "101-term addition", sql: chain(101), params: [] },
  { name: "100 result columns", sql: columns(100), params: [] },
  { name: "101 result columns", sql: columns(101), params: [] },
  { name: "100 bound parameters", sql: placeholders(100), params: Array.from({ length: 100 }, (_, i) => i) },
  { name: "101 bound parameters", sql: placeholders(101), params: Array.from({ length: 101 }, (_, i) => i) },
  { name: "100,000-byte statement", sql: padded(100_000), params: [] },
  { name: "100,001-byte statement", sql: padded(100_001), params: [] },
  { name: "bound LIKE pattern of 50 bytes", sql: "select 'a' like ?", params: ["a".repeat(50)] },
  { name: "bound LIKE pattern of 51 bytes", sql: "select 'a' like ?", params: ["a".repeat(51)] },
  { name: "zeroblob(2,000,001)", sql: blob(2_000_001), params: [] },
  { name: "zeroblob(4,194,305)", sql: blob(4_194_305), params: [] },
  { name: "zeroblob(8,388,643)", sql: blob(8_388_643), params: [] },
  { name: "about 10,000 EXPLAIN rows", sql: values(5_000), params: [] },
  { name: "about 30,000 EXPLAIN rows", sql: values(15_000), params: [] },
];

export async function runLimitProbes(execute: (sql: string, params: unknown[]) => unknown): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of LIMIT_PROBES) {
    try {
      await execute(probe.sql, probe.params);
      results.push({ name: probe.name, result: "pass" });
    } catch (e) {
      results.push({ name: probe.name, result: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
