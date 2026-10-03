// Fixture: a schema and a catalog whose queries pass an enclosing query's
// column to a table-valued function inside a subquery. test/analyze.test.ts
// checks that correlated-json-each.generated.ts is the current analyze
// output for them and runs them on node:sqlite. test/miniflare/
// correlated-json-each.test.ts runs the same generated file on D1 and on a
// Durable Object through test/correlated-json-each.worker.ts.
// Boundary: data only; no adapter and no assertion here.
export const schema = "CREATE TABLE items (id TEXT PRIMARY KEY, labels TEXT NOT NULL);";

export const catalog = {
  byLabel: "SELECT items.* FROM items WHERE EXISTS (SELECT 1 FROM json_each(items.labels) WHERE value = :label) ORDER BY items.id",
  // A join form that does not correlate the function, for a result comparison.
  byLabelJoin: "SELECT items.* FROM items WHERE id IN (SELECT tagged.id FROM items AS tagged, json_each(tagged.labels) AS label WHERE label.value = :label) ORDER BY items.id",
  labelCounts: "SELECT id, (SELECT cast(count(*) AS integer) FROM json_each(items.labels)) AS labelCount FROM items ORDER BY id",
};

// Duplicate labels, an empty array, and a number that matches no text label.
export const rows: [string, string][] = [
  ["a", JSON.stringify(["red", "blue"])],
  ["b", JSON.stringify(["blue"])],
  ["c", JSON.stringify([])],
  ["d", JSON.stringify(["red", "red"])],
  ["e", JSON.stringify([1])],
];

export const labels = ["red", "blue", "1", "none"];
