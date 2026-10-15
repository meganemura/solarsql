// The example on a deployed Worker: the steps of example-steps.ts against
// remote D1 and a Durable Object in production, after a reset of both
// stores. Opt-in: SOLARSQL_REMOTE_URL names the Worker, and
// SOLARSQL_REMOTE_TOKEN carries its TOKEN secret when it has one. Without
// the URL the test is skipped, so `npm test` needs no account. The limits
// test prints the deployed platform's answers and asserts none of them,
// because the deployed values are what it measures (ADR 0134). The trigger
// test reaches D1's HTTP API through wrangler, so it also needs
// example/wrangler.jsonc and a wrangler that is logged in (ADR 0036).
import { beforeAll, describe, onTestFinished, test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exampleSteps, type Reply } from "./example-steps.ts";
import { deployedLimits, fetchSend, markdownTable } from "../spike/17-deployed-limits.ts";

const url = process.env.SOLARSQL_REMOTE_URL;
const token = process.env.SOLARSQL_REMOTE_TOKEN;

if (url === undefined) {
  // set SOLARSQL_REMOTE_URL to the Worker's URL to run
  test.skip("the example on a deployed Worker", () => {});
} else {
  for (const target of ["d1", "do"] as const) {
    describe(`example on remote ${target}`, () => {
      const send = async (body: Record<string, unknown>): Promise<Reply> => {
        const response = await fetch(new URL(target === "do" ? "/do" : "/", url), {
          method: "POST",
          body: JSON.stringify(body),
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        });
        const text = await response.text();
        assert.equal(response.status, 200, `${response.status} ${text}`);
        return JSON.parse(text) as Reply;
      };
      const value = async (body: Record<string, unknown>): Promise<unknown> => {
        const reply = await send(body);
        assert.equal(reply.ok, true, JSON.stringify(reply));
        return (reply as { value: unknown }).value;
      };

      beforeAll(async () => {
        await value({ step: "reset" });
      });

      exampleSteps(value, { oneIsolate: target === "do", engineMeta: target === "d1" || target === "do" });
    });
  }

  test("the deployed platform's SQLite limits and four json_each sizes (prints the table)", async () => {
    const rows = await deployedLimits(fetchSend(url, token));
    console.log(markdownTable(rows));
    assert.ok(rows.every((row) => row.do !== "missing"), "the Durable Object answered every probe that D1 answered");
  });

  // A Worker's D1 binding takes one statement per call and never meets the
  // HTTP API's own statement splitter, which `wrangler d1 migrations apply
  // --remote` and `wrangler d1 execute --remote --command` both go through.
  // The uppercase trigger is the control: it shows the refusal is the case of
  // BEGIN, not the table, the login, or the request.
  test("D1's HTTP API refuses a trigger body opened by a lowercase begin, and takes BEGIN", async () => {
    const example = resolve(import.meta.dirname, "../example");
    assert.ok(existsSync(resolve(example, "wrangler.jsonc")), "example/wrangler.jsonc names the deployed database; copy it from wrangler.example.jsonc (deploy.md)");
    const wrangler = resolve(import.meta.dirname, "../node_modules/wrangler/bin/wrangler.js");
    const execute = (sql: string) =>
      new Promise<{ ok: boolean; output: string }>((done) => {
        execFile(process.execPath, [wrangler, "d1", "execute", "DB", "--remote", "--json", "--command", sql], { cwd: example }, (error, stdout, stderr) => {
          done({ ok: error === null, output: `${stdout}${stderr}` });
        });
      });
    const table = `begin_case_${randomUUID().replaceAll("-", "")}`;
    const trigger = (name: string, begin: string) => `CREATE TRIGGER ${table}_${name} after insert on ${table}\n${begin}\n  select 1;\nEND;`;
    onTestFinished(async () => {
      const dropped = await execute(`drop table if exists ${table}`);
      assert.ok(dropped.ok, `the table ${table} is left on the remote D1: ${dropped.output}`);
    });
    const created = await execute(`create table ${table} (id integer primary key)`);
    assert.ok(created.ok, created.output);
    const lower = await execute(trigger("lower", "begin"));
    assert.equal(lower.ok, false, `the lowercase begin was accepted: ${lower.output}`);
    assert.match(lower.output, /incomplete input/);
    const upper = await execute(trigger("upper", "BEGIN"));
    assert.ok(upper.ok, upper.output);
  });
}
