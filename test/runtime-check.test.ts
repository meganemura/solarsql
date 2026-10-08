// Responsibility: the runtime check's verdicts and messages, through
// runtimeRefusal() and through the CLI's output.
// Boundary: no real Bun runs here; the CLI cases define process.versions.bun
// in a child Node process.
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runtimeRefusal } from "../src/runtime/runtime-check.ts";

const REQUIREMENT = "solarsql requires Node ^24.20.0 || >=26.7.0 and node:sqlite on SQLite 3.53.4 or later, the SQLite that workerd runs in the release's tests.";

const cli = fileURLToPath(new URL("../src/build/cli.ts", import.meta.url));
const asBun = `data:text/javascript,${encodeURIComponent('Object.defineProperty(process.versions, "bun", { value: "1.4.2", enumerable: true, configurable: true });')}`;

function runAsBun(...args: string[]) {
  return spawnSync(process.execPath, ["--import", asBun, cli, ...args], { encoding: "utf8", timeout: 30_000 });
}

test("the CLI prints the refusal as one line, and as a JSON diagnostic when it reports JSON", () => {
  const probe = new DatabaseSync(":memory:");
  const sqlite = String(probe.prepare("select sqlite_version() as version").get()!.version);
  probe.close();
  const message = `${REQUIREMENT} This process runs Bun 1.4.2, which reports Node ${process.versions.node}, and its node:sqlite runs SQLite ${sqlite}. solarsql does not support Bun; run the command with Node.`;
  const human = runAsBun("build");
  assert.deepEqual([human.status, human.stdout, human.stderr], [1, "", `${message}\n`]);
  const machine = runAsBun("build", "--json");
  assert.deepEqual([machine.status, JSON.parse(machine.stdout)], [1, { version: 1, ok: false, diagnostics: [{ code: "UNSUPPORTED_RUNTIME", message }] }]);
  const inspect = runAsBun("inspect");
  assert.deepEqual([inspect.status, JSON.parse(inspect.stdout)], [1, { version: 1, ok: false, diagnostics: [{ code: "UNSUPPORTED_RUNTIME", message }] }]);
  const query = runAsBun("query", "shop.customerQueries.byId", "--database", "shop.sqlite");
  assert.deepEqual([query.status, query.stdout, query.stderr], [2, "", `error: ${message}\n`]);
});

test("the CLI answers --version without the runtime check", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const answer = runAsBun("--version");
  assert.deepEqual([answer.status, answer.stdout.trim()], [0, version]);
});

test("Node 26.7.0 with SQLite 3.53.4 is accepted", () => {
  assert.equal(runtimeRefusal({ node: "26.7.0" }, "3.53.4"), null);
});

test("Bun is refused by name, with the Node version it reports and its own SQLite", () => {
  const refusal = runtimeRefusal({ node: "26.3.0", bun: "1.4.2" }, "3.51.0");
  assert.equal(refusal?.code, "UNSUPPORTED_RUNTIME");
  assert.equal(refusal?.name, "UnsupportedRuntimeError");
  assert.equal(refusal?.message, `${REQUIREMENT} This process runs Bun 1.4.2, which reports Node 26.3.0, and its node:sqlite runs SQLite 3.51.0. solarsql does not support Bun; run the command with Node.`);
});

test("Deno is refused by name", () => {
  assert.equal(runtimeRefusal({ node: "24.20.0", deno: "2.5.0" }, "3.53.4")?.message,
    `${REQUIREMENT} This process runs Deno 2.5.0, which reports Node 24.20.0, and its node:sqlite runs SQLite 3.53.4. solarsql does not support Deno; run the command with Node.`);
});

test("a Node release outside the range is refused with its SQLite", () => {
  assert.equal(runtimeRefusal({ node: "24.18.0" }, "3.53.1")?.message,
    `${REQUIREMENT} This process runs Node 24.18.0, and its node:sqlite runs SQLite 3.53.1. Install a Node release in that range.`);
});

test("a Node release in the range whose node:sqlite runs an older SQLite is refused", () => {
  assert.equal(runtimeRefusal({ node: "26.7.0" }, "3.50.4")?.message,
    `${REQUIREMENT} This process runs Node 26.7.0, but its node:sqlite runs SQLite 3.50.4, older than 3.53.4. A Node build that links a system SQLite can do this; use an official Node build.`);
});

test("a node:sqlite that gives no SQLite version is refused, and a Bun process is still named first", () => {
  assert.equal(runtimeRefusal({ node: "26.7.0" }, null)?.message,
    `${REQUIREMENT} This process runs Node 26.7.0, but its node:sqlite reports no SQLite version.`);
  assert.equal(runtimeRefusal({ node: "26.3.0", bun: "1.3.14" }, null)?.message,
    `${REQUIREMENT} This process runs Bun 1.3.14, which reports Node 26.3.0, and its node:sqlite reports no SQLite version. solarsql does not support Bun; run the command with Node.`);
});

const nodeCases: [string, boolean][] = [
  ["24.19.0", false],
  ["24.20.0", true],
  ["25.9.0", false],
  ["26.6.0", false],
  ["26.7.0", true],
  ["27.0.0", true],
  ["23.20.123", false],
  ["not-a-version", false],
  ["prefix24.20.123", false],
];

for (const [version, accepted] of nodeCases) {
  test(`Node ${version} is ${accepted ? "accepted" : "refused"}`, () => {
    assert.equal(runtimeRefusal({ node: version }, "3.53.4") === null, accepted);
  });
}

// "3.9.99" and "3.100.0" sort the other way as strings.
const sqliteCases: [string, boolean][] = [
  ["3.53.3", false],
  ["3.53.4", true],
  ["3.53.10", true],
  ["3.54.0", true],
  ["4.0.0", true],
  ["3.9.99", false],
  ["3.100.0", true],
  ["unavailable", false],
];

for (const [version, accepted] of sqliteCases) {
  test(`SQLite ${version} is ${accepted ? "accepted" : "refused"} on Node 26.7.0`, () => {
    assert.equal(runtimeRefusal({ node: "26.7.0" }, version) === null, accepted);
  });
}

test("patch digits and trailing text preserve the major and minor decision", async () => {
  const { test: property } = await import("@hegeldev/hegel");
  const gs = await import("@hegeldev/hegel/generators");
  property(tc => {
    const patch = tc.draw(gs.text({ alphabet: "0123456789", minSize: 1, maxSize: 100 }));
    const suffix = tc.draw(gs.text({ maxSize: 30 }));
    for (const [base, accepted] of [["24.19", false], ["24.20", true], ["25.20", false], ["26.6", false], ["26.7", true], ["27.0", true]] as const) {
      const version = `${base}.${patch}${suffix}`;
      const refusal = runtimeRefusal({ node: version }, "3.53.4");
      if (accepted) assert.equal(refusal, null);
      else assert.ok(refusal?.message.includes(`This process runs Node ${version}, and`));
    }
  });
});

test("the SQLite floor compares each component as a number", async () => {
  const { test: property } = await import("@hegeldev/hegel");
  const gs = await import("@hegeldev/hegel/generators");
  property(tc => {
    const major = tc.draw(gs.integers({ minValue: 2, maxValue: 4 }));
    const minor = tc.draw(gs.integers({ minValue: 0, maxValue: 120 }));
    const patch = tc.draw(gs.integers({ minValue: 0, maxValue: 120 }));
    const atLeastFloor = major > 3 || (major === 3 && (minor > 53 || (minor === 53 && patch >= 4)));
    assert.equal(runtimeRefusal({ node: "26.7.0" }, `${major}.${minor}.${patch}`) === null, atLeastFloor);
  });
});

test("a Bun process is refused whatever Node version it reports and whatever SQLite it runs", async () => {
  const { test: property } = await import("@hegeldev/hegel");
  const gs = await import("@hegeldev/hegel/generators");
  property(tc => {
    const bun = tc.draw(gs.text({ maxSize: 20 }));
    const reported = tc.draw(gs.sampledFrom(["24.20.0", "26.3.0", "26.7.0", "99.0.0"]));
    const sqlite = tc.draw(gs.sampledFrom(["3.51.0", "3.53.4", "3.60.0"]));
    const refusal = runtimeRefusal({ node: reported, bun }, sqlite);
    assert.ok(refusal?.message.includes(`This process runs Bun ${bun}, which reports Node ${reported}, and its node:sqlite runs SQLite ${sqlite}.`));
  });
});
