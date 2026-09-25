// The id generator: version 7, the variant bits, and the order of ids as
// strings follows the order they were made in, across milliseconds and
// within one.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { uuidV7 } from "../src/runtime/id.ts";
import { newId, type Id } from "../src/index.ts";

const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The millisecond field, read back from an id string.
const millis = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
// The 12-bit counter, read back from an id string: the 3 hex digits
// after the version nibble "7" (id[14]).
const counterOf = (id: string) => parseInt(id.slice(15, 18), 16);
// The last 64 bits, 62 of which come only from the random source (the
// other 2 are the fixed variant bits, always "10").
const randomTail = (id: string) => id.slice(19, 23) + id.slice(24);

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

test("the random bits differ across ids made in different milliseconds", () => {
  // If the random source were skipped, this portion would stay the zero
  // bytes a fresh Uint8Array starts with, in every id.
  let t = 2_000_000_000_000;
  hegel.test((tc) => {
    const count = tc.draw(gs.integers({ minValue: 20, maxValue: 40 }));
    const tails: string[] = [];
    for (let i = 0; i < count; i++) {
      // A step of at least 1 keeps every call in a millisecond of its
      // own, even across draws, since lastMs never moves backward.
      t += tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
      tails.push(randomTail(uuidV7(t)));
    }
    assert.equal(new Set(tails).size, tails.length);
  });
});

test("a new millisecond's counter starts below 0x800, even after a run of ids pushed it past 0x800", () => {
  // The reset branch, and its starting point, only run when the
  // millisecond changes; a run within one millisecond must not trip it.
  const t = 2_100_000_000_000;
  let counter = 0;
  for (let i = 0; i < 3000 && counter < 0x800; i++) {
    counter = counterOf(uuidV7(t));
  }
  assert.ok(counter >= 0x800, "setup must reach a counter of 0x800 or more before the check below means anything");
  const nextId = uuidV7(2_100_000_100_000);
  assert.ok(counterOf(nextId) < 0x800);
});

test("the counter counts up to 0xfff before the millisecond rolls over", () => {
  // The last id of one millisecond carries counter 0xfff; the first id
  // of the next carries counter 0, not some other split.
  const t = 2_200_000_000_000;
  let prevId = uuidV7(t);
  let id = uuidV7(t);
  let guard = 0;
  while (millis(id) === t && guard < 5000) {
    prevId = id;
    id = uuidV7(t);
    guard++;
  }
  assert.equal(millis(id), t + 1);
  assert.equal(counterOf(prevId), 0xfff);
  assert.equal(counterOf(id), 0);
});
