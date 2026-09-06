// The id generator: version 7, the variant bits, and the order of ids as
// strings follows the order they were made in, across milliseconds and
// within one.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { uuidV7 } from "../src/runtime/id.ts";
import { newId, type Id } from "../src/index.ts";

const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("ids sort in the order they were made, across and within milliseconds", () => {
  hegel.test((tc) => {
    const start = tc.draw(gs.integers({ minValue: 1_700_000_000_000, maxValue: 1_800_000_000_000 }));
    const steps = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 3 }), { minSize: 2, maxSize: 60 }));
    let t = start;
    const ids: string[] = [];
    for (const step of steps) {
      t += step;
      ids.push(uuidV7(t));
    }
    for (const id of ids) assert.match(id, shape);
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1]! < ids[i]!, `${ids[i - 1]} < ${ids[i]}`);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test("five thousand ids in one millisecond stay unique and in order, and the counter rolls the millisecond on", () => {
  // The counter starts below 0x800 and overflows past 0xfff, so the
  // millisecond moves on after 2048 to 4096 ids. Five thousand cross it.
  const t = 1_900_000_000_000;
  const ids = Array.from({ length: 5000 }, () => uuidV7(t));
  assert.equal(new Set(ids).size, 5000);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1]! < ids[i]!);
  const millis = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  assert.equal(millis(ids[0]!), t);
  assert.equal(millis(ids[4999]!), t + 1);
});

test("the first 48 bits are the millisecond, and newId is the branded string", () => {
  const t = 1_950_000_000_000;
  const id = uuidV7(t);
  assert.equal(parseInt(id.slice(0, 8) + id.slice(9, 13), 16), t);
  const branded: Id<"orders"> = newId<Id<"orders">>();
  assert.match(branded, shape);
});
