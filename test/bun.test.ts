// Responsibility: what the Bun CI job proves about a real Bun process
// (ADR 0147): node() accepts it and runs the example's modules, and the CLI
// still refuses it.
// Boundary: on Node every test here is skipped; test/runtime-check.test.ts
// covers the verdicts with versions it makes up.
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { migrate, node } from "../src/node.ts";
import { linkedSqliteVersion, runtimeRefusal } from "../src/runtime/runtime-check.ts";
import { migrations } from "../example/migrations/index.ts";
import { customerCommands, type CustomersId } from "../example/modules/customers/public.ts";

const onBun = process.versions.bun !== undefined;

test.runIf(onBun)("node() accepts this Bun process and runs a command on it", async () => {
  assert.equal(runtimeRefusal(process.versions, linkedSqliteVersion(), "node()"), null);
  const raw = new DatabaseSync(":memory:");
  try {
    migrate(raw, migrations);
    const db = node(raw);
    assert.deepEqual(await db.run(customerCommands.create, { id: "c1" as CustomersId, name: "Ada", email: "ada@example.com" }),
      { ok: true, rows: [{ id: "c1", name: "Ada", email: "ada@example.com" }], changes: 1 });
  } finally { raw.close(); }
});

test.runIf(onBun)("the CLI refuses this Bun process by name", () => {
  const cli = fileURLToPath(new URL("../src/build/cli.ts", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "build"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`This process runs Bun ${process.versions.bun!.replaceAll(".", "\\.")}, .* The solarsql CLI does not support Bun; run the command with Node\\.\n$`));
});
