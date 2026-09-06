// The build reports the statements it added and removed. For any two lists
// of keys, the report and the old list rebuild the new list, and no key is
// both added and removed.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { keyDiff } from "../src/build/build.ts";

const key = gs.fromRegex("[a-c]{1,3}");
const keys = gs.arrays(key, { maxSize: 8 });

describe("keyDiff", () => {
  test("added and removed are disjoint, and (before - removed) + added = after", () => {
    hegel.test((tc) => {
      const before = tc.draw(keys);
      const after = tc.draw(keys);
      const { added, removed } = keyDiff(before, after);
      assert.equal(added.filter((k) => removed.includes(k)).length, 0);
      assert.ok(added.every((k) => after.includes(k) && !before.includes(k)));
      assert.ok(removed.every((k) => before.includes(k) && !after.includes(k)));
      const rebuilt = new Set([...before.filter((k) => !removed.includes(k)), ...added]);
      assert.deepEqual([...rebuilt].sort(), [...new Set(after)].sort());
    });
  });
});
