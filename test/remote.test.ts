// The example on a deployed Worker: the steps of example-steps.ts against
// remote D1 and a Durable Object in production, after a reset of both
// stores. Opt-in: SOLARSQL_REMOTE_URL names the Worker, and
// SOLARSQL_REMOTE_TOKEN carries its TOKEN secret when it has one. Without
// the URL the test is skipped, so `npm test` needs no account.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { exampleSteps, type Reply } from "./example-steps.ts";

const url = process.env.SOLARSQL_REMOTE_URL;
const token = process.env.SOLARSQL_REMOTE_TOKEN;

if (url === undefined) {
  test("the example on a deployed Worker", { skip: "set SOLARSQL_REMOTE_URL to the Worker's URL to run" }, () => {});
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

      before(async () => {
        await value({ step: "reset" });
      });

      exampleSteps(value, { oneIsolate: target === "do" });
    });
  }
}
