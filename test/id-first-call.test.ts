// Responsibility: the process's very first uuidV7 call, before any state
// from an earlier call exists. Kept in its own file because id.ts holds
// its clock state at module scope, and only a fresh process gives this
// call a clean lastMs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { uuidV7 } from "../src/runtime/id.ts";

test("the process's first uuidV7 call, given 0, puts 0 in the millisecond field", () => {
  // Before any call, lastMs holds no prior millisecond; the millisecond
  // field must hold exactly the time given, even when that time is 0.
  const id = uuidV7(0);
  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  assert.equal(ms, 0);
});
