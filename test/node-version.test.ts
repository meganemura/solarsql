// The Node floor check: a table of versions on each side of the range.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeVersionError } from "../src/runtime/node-version.ts";

const cases: [string, boolean][] = [
  ["24.19.0", false],
  ["24.20.0", true],
  ["25.9.0", false],
  ["26.6.0", false],
  ["26.7.0", true],
  ["27.0.0", true],
];

for (const [version, accepted] of cases) {
  test(`${version} is ${accepted ? "accepted" : "refused"}`, () => {
    const error = nodeVersionError(version);
    if (accepted) assert.equal(error, null);
    else {
      assert.match(error!, /\^24\.20\.0 \|\| >=26\.7\.0/);
      assert.match(error!, new RegExp(version.replace(/\./g, "\\.")));
    }
  });
}

test("an unparseable version is refused", () => {
  assert.match(nodeVersionError("not-a-version")!, /unparseable/);
});
