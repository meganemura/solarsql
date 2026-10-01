// The Node floor check: a table of versions on each side of the range.
import { test } from "vitest";
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

test("a version with leading text is unparseable", () => {
  assert.match(nodeVersionError("prefix24.20.123")!, /unparseable/);
});

test("an older major with a high minor is refused", () => {
  assert.match(nodeVersionError("23.20.123")!, /Node reports 23\.20\.123/);
});

test("patch digits and trailing text preserve the major and minor decision", async () => {
  const { test: property } = await import("@hegeldev/hegel");
  const gs = await import("@hegeldev/hegel/generators");
  property(tc => {
    const patch = tc.draw(gs.text({ alphabet: "0123456789", minSize: 1, maxSize: 100 }));
    const suffix = tc.draw(gs.text({ maxSize: 30 }));
    for (const [base, accepted] of [["24.19", false], ["24.20", true], ["25.20", false], ["26.6", false], ["26.7", true], ["27.0", true]] as const) {
      const version = `${base}.${patch}${suffix}`;
      const error = nodeVersionError(version);
      if (accepted) assert.equal(error, null);
      else assert.ok(error?.endsWith(`Node reports ${version}.`));
    }
  });
});
