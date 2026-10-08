// The example on a deployed Worker: the steps of example-steps.ts against
// remote D1 and a Durable Object in production, after a reset of both
// stores. Opt-in: SOLARSQL_REMOTE_URL names the Worker, and
// SOLARSQL_REMOTE_TOKEN carries its TOKEN secret when it has one. Without
// the URL the test is skipped, so `npm test` needs no account. The limits
// test prints the deployed platform's answers and asserts none of them,
// because the deployed values are what it measures (ADR 0134).
import { beforeAll, describe, test } from "vitest";
import assert from "node:assert/strict";
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
}
