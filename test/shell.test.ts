// Responsibility: verify displayed shell arguments and their string round trip.
// Boundary: the decoder handles the quoting forms emitted by this module; it runs no shell.
import assert from "node:assert/strict";
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { shellArgument } from "../src/build/shell.ts";

test("shell arguments quote unsafe prefixes, suffixes, empty strings, and apostrophes", () => {
  for (const [input, expected] of [
    ["abc-12_./", "abc-12_./"], ["a", "a"], ["", "''"],
    [" space", "' space'"], ["space ", "'space '"], ["$", "'$'"],
    ["it's", `'it'"'"'s'`],
  ]) assert.equal(shellArgument(input!), expected);
});

test("shell argument quoting preserves generated Unicode text", () => {
  hegel.test(tc => {
    const input = tc.draw(gs.text({ maxSize: 100 }));
    const quoted = shellArgument(input);
    const decoded = quoted.startsWith("'") ? quoted.slice(1, -1).split(`'"'"'`).join("'") : quoted;
    assert.equal(decoded, input);
  });
});
