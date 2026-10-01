// Responsibility: verify generated writes and input protection through real files.
// Boundary: these tests do not change the process version or replace file system calls.
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test, vi } from "vitest";
import { protectInputs, writeGeneratedFile } from "../src/build/output.ts";
import { BuildError } from "../src/build/build-error.ts";

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-output-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const aliasMessage = "The generated output must differ from every input and SQLite companion file, including file aliases.";

test("input protection rejects an identical missing path", () => {
  const path = join(directory(), "missing");
  assert.throws(() => protectInputs(path, [path]), { name: "BuildError", message: aliasMessage });
});

test("input protection accepts distinct missing and existing paths", () => {
  const dir = directory();
  const existing = join(dir, "existing");
  const other = join(dir, "other");
  const missing = join(dir, "missing");
  writeFileSync(existing, "source");
  writeFileSync(other, "other source");
  for (const [output, input] of [[missing, existing], [existing, missing], [missing, other + ".missing"], [existing, other]]) {
    assert.doesNotThrow(() => protectInputs(output!, [input!]));
  }
});

test("input protection rejects hard links and symbolic aliases", () => {
  const dir = directory();
  const source = join(dir, "source");
  const hard = join(dir, "hard");
  const symbolic = join(dir, "symbolic");
  writeFileSync(source, "source");
  linkSync(source, hard);
  symlinkSync("source", symbolic);
  for (const alias of [hard, symbolic]) {
    assert.throws(() => protectInputs(alias, [source]), { name: "BuildError", message: aliasMessage });
  }
  assert.equal(readFileSync(source, "utf8"), "source");
});

test("equal inode numbers on different devices are separate inputs", (context) => {
  // Mounted roots can reuse an inode number. Compare real roots so the test
  // checks the device distinction without inventing file system metadata.
  const roots = ["/", "/dev", "/proc", "/sys", "/System/Volumes/Preboot", "/System/Volumes/VM"];
  const existing = roots.flatMap(path => {
    try { return [{ path, stat: statSync(path) }]; } catch { return []; }
  });
  const pair = existing.flatMap(a => existing.filter(b => a.stat.dev !== b.stat.dev && a.stat.ino === b.stat.ino).map(b => [a.path, b.path]));
  if (pair.length === 0) { context.skip(); return; }
  for (const [output, input] of pair) assert.doesNotThrow(() => protectInputs(output!, [input!]));
});

test("symbolic link cycles report a build error", () => {
  const dir = directory();
  const first = join(dir, "first");
  symlinkSync("second", first);
  symlinkSync("first", join(dir, "second"));
  assert.throws(() => writeGeneratedFile(first, "text"), { name: "BuildError", message: "The output contains a symbolic link cycle." });
  assert.throws(() => protectInputs(first, []), BuildError);
});

test("a failed rename removes the temporary file", () => {
  const dir = directory();
  const target = join(dir, "target");
  mkdirSync(target);
  assert.throws(() => writeGeneratedFile(target, "text"));
  assert.deepEqual(readdirSync(dir), ["target"]);
});

// This test depends on the POSIX name limit of 255 bytes and on the
// ENAMETOOLONG error for a longer name, so it runs only on POSIX systems.
test.skipIf(process.platform === "win32")("a cleanup failure reports the unlink error", () => {
  const target = join(directory(), "x".repeat(255));
  assert.throws(() => writeGeneratedFile(target, "text"), (error: unknown) => {
    assert.ok(error instanceof Error);
    const failure = error as NodeJS.ErrnoException;
    assert.equal(failure.code, "ENAMETOOLONG");
    assert.equal(failure.syscall, "unlink");
    return true;
  });
});

test("a temporary name collision preserves the existing file contents", () => {
  const dir = directory();
  const target = join(dir, "target");
  writeFileSync(target, "previous output");
  const random = Math.random;
  let collision = "";
  // Observe the real entropy and create a competing file before the writer
  // opens it. The sampled value and file system calls retain their real behavior.
  const observation = vi.spyOn(Math, "random").mockImplementation(() => {
    const value = random();
    collision = join(dir, `.target.${process.pid}.${value.toString(16).slice(2)}.tmp`);
    writeFileSync(collision, "competing output");
    linkSync(collision, join(dir, "retained"));
    return value;
  });
  try {
    assert.throws(() => writeGeneratedFile(target, "replacement"), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
      return true;
    });
    assert.equal(readFileSync(join(dir, "retained"), "utf8"), "competing output");
    assert.equal(readFileSync(target, "utf8"), "previous output");
  } finally { observation.mockRestore(); }
});

test("generated writes follow a symbolic destination to its target and leave no temporary file", () => {
  const dir = directory();
  const target = join(dir, "target");
  const alias = join(dir, "alias");
  writeFileSync(target, "old");
  symlinkSync("target", alias);
  writeGeneratedFile(alias, "new");
  assert.equal(readFileSync(target, "utf8"), "new");
  assert.equal(readFileSync(alias, "utf8"), "new");
  assert.deepEqual(readdirSync(dir).sort(), ["alias", "target"]);
});

// This test sizes the name for the POSIX name limit of 255 bytes, so it
// runs only on POSIX systems.
test.skipIf(process.platform === "win32")("generated writes support a destination near the component length limit", () => {
  const dir = directory();
  // Node's random source uses a 53-bit fraction, which needs at most fourteen
  // hexadecimal digits. Reserve those digits, the pid, and the other name parts.
  const name = "x".repeat(255 - process.pid.toString().length - 21);
  const target = join(dir, name);
  for (let i = 0; i < 10; i++) {
    writeGeneratedFile(target, String(i));
    assert.equal(readFileSync(target, "utf8"), String(i));
  }
  assert.deepEqual(readdirSync(dir), [name]);
});
