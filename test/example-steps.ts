// The steps of the example, as one request each to the Worker in
// example/worker.ts, with the replies they must give. test/example.test.ts
// runs them on Miniflare, and test/remote.test.ts on a deployed Worker.
// Boundary: no transport here. The caller sends a step and returns the value
// of the reply, and fails the test when the reply is an error.
import { test } from "node:test";
import assert from "node:assert/strict";

export type Reply = { ok: true; value: unknown } | { ok: false; message: string; cause: string | null };

export type Value = (body: Record<string, unknown>) => Promise<unknown>;

// `oneIsolate` is false when the Worker may run in several isolates, as a
// deployed one does: then the observe hook's events are not all in one place.
// `engineMeta` is true on D1, which reports the rows read and written.
export function exampleSteps(value: Value, options: { oneIsolate: boolean; engineMeta: boolean }): void {
  test("a command with returns gives typed rows", async () => {
    const created = await value({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" });
    assert.deepEqual(created, { ok: true, rows: [{ id: "c1", name: "Ann", email: "ann@example.com" }] });
  });

  test("a plan inserts a parent and its children from JSON in one transaction", async () => {
    const placed = await value({
      step: "placeOrder",
      id: "o1",
      customer_id: "c1",
      lines: [
        { id: "l1", sku: "A", qty: 2, price: 1.5 },
        { id: "l2", sku: "B", qty: 1, price: 4 },
      ],
    });
    assert.deepEqual(placed, { ok: true, rows: [{ id: "o1", customer_id: "c1", status: "draft", note: null }] });
  });

  test("a JSON aggregation arrives as an array", async () => {
    const order = await value({ step: "order", id: "o1" });
    assert.deepEqual(order, {
      id: "o1",
      status: "draft",
      lines: [
        { id: "l1", sku: "A", qty: 2, price: 1.5 },
        { id: "l2", sku: "B", qty: 1, price: 4 },
      ],
    });
  });

  test("a bulk update from JSON rows, through one json_each parameter used twice", async () => {
    const repriced = await value({ step: "reprice", id: "o1", lines: [{ id: "l1", price: 2 }, { id: "l2", price: 5 }] });
    assert.deepEqual(repriced, { ok: true, rows: [{ id: "o1", customer_id: "c1", status: "draft", note: null }] });
    const order = (await value({ step: "order", id: "o1" })) as { lines: { id: string; price: number }[] };
    assert.deepEqual(order.lines.map((l) => [l.id, l.price]), [["l1", 2], ["l2", 5]]);
    // A line of another order, or an unknown one, fails the assert and changes nothing.
    const refused = await value({ step: "reprice", id: "o1", lines: [{ id: "l1", price: 9 }, { id: "nope", price: 9 }] });
    assert.deepEqual(refused, { ok: false, kind: "assert", assert: "all_lines_known" });
    const same = (await value({ step: "order", id: "o1" })) as { lines: { id: string; price: number }[] };
    assert.deepEqual(same.lines.map((l) => l.price), [2, 5]);
    // Back to the prices the later tests count on.
    await value({ step: "reprice", id: "o1", lines: [{ id: "l1", price: 1.5 }, { id: "l2", price: 4 }] });
  });

  test("three reads in one batch, typed by position", async () => {
    const overview = await value({ step: "overview", id: "o1" });
    assert.deepEqual(overview, {
      order: { id: "o1", customer_id: "c1", status: "draft", note: null },
      lines: [{ id: "l1", sku: "A", qty: 2, price: 1.5 }, { id: "l2", sku: "B", qty: 1, price: 4 }],
      customers: [{ id: "c1", name: "Ann", email: "ann@example.com" }],
    });
  });

  test("asserts pass, then the second run names the failed assert", async () => {
    const first = await value({ step: "confirm", id: "o1" });
    assert.deepEqual(first, { ok: true, rows: [{ id: "o1", customer_id: "c1", status: "confirmed", note: null }] });
    const second = await value({ step: "confirm", id: "o1" });
    assert.deepEqual(second, { ok: false, kind: "assert", assert: "was_draft" });
  });

  test("a unique constraint of the DDL arrives as a value that names the columns", async () => {
    const duplicate = await value({ step: "createCustomer", id: "c2", name: "Bob", email: "ann@example.com" });
    assert.deepEqual(duplicate, { ok: false, kind: "unique", table: "customers", columns: ["email"] });
    assert.deepEqual(await value({ step: "customers" }), [{ id: "c1", name: "Ann", email: "ann@example.com" }]);
  });

  test("a CHECK of the DDL arrives as a value that names the constraint", async () => {
    // The constraint came in a rebuild of customers under the foreign key of orders (migration 0005).
    const empty = await value({ step: "createCustomer", id: "c3", name: "", email: "c3@example.com" });
    assert.deepEqual(empty, { ok: false, kind: "check", constraint: "length(name) > 0" });
  });

  test("an order without lines cannot be confirmed", async () => {
    await value({ step: "placeOrder", id: "o2", customer_id: "c1", lines: [] });
    const result = await value({ step: "confirm", id: "o2" });
    assert.deepEqual(result, { ok: false, kind: "assert", assert: "has_lines" });
    const order = await value({ step: "order", id: "o2" });
    assert.deepEqual(order, { id: "o2", status: "draft", lines: [] });
  });

  test("a nullable parameter accepts null, and the trigger stamps the update", async () => {
    const noted = (await value({ step: "annotate", id: "o1", note: "rush" })) as { ok: true; rows: { id: string; note: string | null; updated_at: string | null }[] };
    assert.equal(noted.rows[0]!.note, "rush");
    assert.match(noted.rows[0]!.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    const cleared = (await value({ step: "annotate", id: "o1", note: null })) as { ok: true; rows: { note: string | null }[] };
    assert.equal(cleared.rows[0]!.note, null);
  });

  test("a report reads through a view of its own", async () => {
    assert.deepEqual(await value({ step: "confirmedOrders" }), [{ id: "o1", customer_id: "c1", customer_name: "Ann" }]);
  });

  test("a failed plan leaves no partial writes, and the failure is a value", async () => {
    // The second line repeats l1, so the primary key of order_lines rejects it inside the plan.
    const result = await value({ step: "placeOrder", id: "o3", customer_id: "c1", lines: [{ id: "l9", sku: "Z", qty: 1, price: 1 }, { id: "l1", sku: "A", qty: 1, price: 1 }] });
    assert.deepEqual(result, { ok: false, kind: "unique", table: "order_lines", columns: ["id"] });
    const orders = await value({ step: "ordersOf", customer_id: "c1" });
    assert.deepEqual(orders, [{ id: "o2", status: "draft" }, { id: "o1", status: "confirmed" }]);
  });

  test("a report module reads across modules with casts", async () => {
    const revenue = await value({ step: "revenue" });
    assert.deepEqual(revenue, [{ customer_id: "c1", name: "Ann", revenue: 7, orders: 1 }]);
  });

  test("an IN list longer than D1's 100 bound values, through one json_each parameter", async () => {
    const ids = ["o1", "o2", ...Array.from({ length: 150 }, (_, i) => `missing${i}`)];
    assert.deepEqual(await value({ step: "ordersByIds", ids }), [{ id: "o1", status: "confirmed" }, { id: "o2", status: "draft" }]);
  });

  test("an optional filter, a sort chosen by a parameter, and paging in one static query", async () => {
    assert.deepEqual(await value({ step: "search", customer_id: "c1", status: null, sort: "id", limit: 10, offset: 0 }), [
      { id: "o1", status: "confirmed", note: null },
      { id: "o2", status: "draft", note: null },
    ]);
    assert.deepEqual(await value({ step: "search", customer_id: "c1", status: "draft", sort: "id", limit: 10, offset: 0 }), [{ id: "o2", status: "draft", note: null }]);
    assert.deepEqual(await value({ step: "search", customer_id: "c1", status: null, sort: "status", limit: 1, offset: 1 }), [{ id: "o2", status: "draft", note: null }]);
  });

  test("a LIKE pattern is a typed parameter, and the query reads the table in full", async () => {
    await value({ step: "annotate", id: "o2", note: "gift wrap" });
    assert.deepEqual(await value({ step: "byNote", pattern: "%gift%" }), [{ id: "o2", status: "draft", note: "gift wrap" }]);
    await value({ step: "annotate", id: "o2", note: null });
  });

  test("a full-text search over the notes, kept in step by triggers", async () => {
    await value({ step: "annotate", id: "o1", note: "gift wrap, ship fast" });
    const hits = (await value({ step: "searchNotes", query: "gift" })) as { id: string; note: string | null; score: number }[];
    assert.deepEqual(hits.map((h) => [h.id, h.note, typeof h.score]), [["o1", "gift wrap, ship fast", "number"]]);
    assert.deepEqual(await value({ step: "searchNotes", query: "rush" }), []);
    await value({ step: "annotate", id: "o1", note: null });
    assert.deepEqual(await value({ step: "searchNotes", query: "gift" }), []);
  });

  test("a query without parameters", async () => {
    assert.deepEqual(await value({ step: "customers" }), [{ id: "c1", name: "Ann", email: "ann@example.com" }]);
  });

  test("the observe hook saw every call with its name and outcome", { skip: options.oneIsolate ? false : "the events of the hook live in one isolate, and a deployed Worker runs several" }, async () => {
    const seen = (await value({ step: "observed" })) as { kind: string; name: string; outcome: string; timed: boolean; meta: { rows_read: number; rows_written: number; duration: number } | null }[];
    assert.ok(seen.every((e) => e.timed));
    // D1 reports its meta on every reply that arrived; a failed plan threw
    // before one did. The other engines report none.
    assert.ok(seen.filter((e) => e.outcome === "ok").every((e) => (e.meta !== null) === options.engineMeta), JSON.stringify(seen.slice(0, 3)));
    assert.ok(seen.filter((e) => e.outcome !== "ok").every((e) => e.meta === null), JSON.stringify(seen.filter((e) => e.outcome !== "ok")));
    if (options.engineMeta) {
      const confirm = seen.find((e) => e.kind === "command" && e.name === "confirm" && e.outcome === "ok")!;
      assert.ok(confirm.meta!.rows_written >= 1, JSON.stringify(confirm));
      const batch = seen.find((e) => e.kind === "batch")!;
      assert.ok(batch.meta!.rows_read >= 1, JSON.stringify(batch));
    }
    const outcomes = seen.map((e) => `${e.kind} ${e.name} ${e.outcome}`);
    assert.ok(outcomes.includes("command confirm ok"), outcomes.join("\n"));
    assert.ok(outcomes.includes("command confirm assert:was_draft"));
    assert.ok(outcomes.includes("command create unique"));
    assert.ok(outcomes.includes("query withLines ok"));
    assert.ok(outcomes.includes("batch byId+withLines+all ok"));
  });

  test("a reset empties the tables of both modules, the search rows too", async () => {
    assert.deepEqual(await value({ step: "reset" }), { ok: true, rows: [] });
    assert.deepEqual(await value({ step: "customers" }), []);
    assert.deepEqual(await value({ step: "ordersOf", customer_id: "c1" }), []);
    await value({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" });
    await value({ step: "placeOrder", id: "o1", customer_id: "c1", lines: [] });
    await value({ step: "annotate", id: "o1", note: "gift" });
    assert.deepEqual((await value({ step: "searchNotes", query: "gift" }) as { id: string }[]).map((h) => h.id), ["o1"]);
    assert.deepEqual(await value({ step: "reset" }), { ok: true, rows: [] });
    assert.deepEqual(await value({ step: "searchNotes", query: "gift" }), []);
  });
}
