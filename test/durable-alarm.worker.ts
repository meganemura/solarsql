// Fixture Worker: proves a Durable Object's alarm handler can run a solarsql
// command. A "/schedule" request migrates the storage and sets an alarm 50ms
// out; workerd fires it with no test API involved. The alarm handler inserts
// one customer through durable(). A "/check" request reads it back, so the
// test (test/miniflare/durable-alarm.test.ts) can poll until the row exists.
// Model: test/durable-object-meta.worker.ts.
import { DurableObject } from "cloudflare:workers";
import { durable, migrate, type StorageLike } from "../src/durable.ts";
import { migrations } from "../example/migrations/index.ts";
import { customerCommands, customerQueries, type CustomersId } from "../example/modules/customers/public.ts";

const id = "c1" as CustomersId;

export class AlarmProbe extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage as unknown as StorageLike;
    migrate(storage, migrations);
    if (new URL(request.url).pathname === "/check") {
      const db = durable(storage);
      const row = await db.first(customerQueries.byId, { id });
      return Response.json({ found: row !== null });
    }
    const withAlarm = this.ctx.storage as unknown as { setAlarm(scheduledTime: number): Promise<void> };
    await withAlarm.setAlarm(Date.now() + 50);
    return new Response("scheduled");
  }

  // Not `override`: example/cloudflare.d.ts's DurableObject stub, owned by
  // another module, declares no alarm() to override; workerd itself still
  // calls this method by name (verified by the test alongside this file).
  async alarm(): Promise<void> {
    const storage = this.ctx.storage as unknown as StorageLike;
    const db = durable(storage);
    await db.run(customerCommands.create, { id, name: "Ann", email: "ann@example.com" });
  }
}

export default {
  async fetch(request: Request, env: { PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const objectId = env.PROBE.idFromName("alarm-probe");
    return env.PROBE.get(objectId).fetch(request);
  },
};
