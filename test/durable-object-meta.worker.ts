// Fixture Worker: a Durable Object that runs durable() (src/durable.ts)
// directly against its own storage, using the example's customers module,
// to prove a real Durable Object's SQL cursor carries rowsRead/rowsWritten
// through the observe hook. Kept separate from example/worker.ts, whose
// shared "Store" instance and full schema are not needed for this one claim.
import { DurableObject } from "cloudflare:workers";
import { durable, migrate, type StorageLike } from "../src/durable.ts";
import { read, type Observed } from "../src/index.ts";
import { migrations } from "../example/migrations/index.ts";
import { customerCommands, customerQueries, type CustomersId } from "../example/modules/customers/public.ts";

export class MetaProbe extends DurableObject {
  override async fetch(): Promise<Response> {
    const storage = this.ctx.storage as unknown as StorageLike;
    migrate(storage, migrations);
    const events: Observed[] = [];
    const db = durable(storage, { observe: (e) => events.push(e) });
    await db.run(customerCommands.create, { id: "c1" as CustomersId, name: "Ann", email: "ann@example.com" });
    await db.batch([read(customerQueries.all), read(customerQueries.byId, { id: "c1" as CustomersId })]);
    return Response.json(events);
  }
}

export default {
  async fetch(request: Request, env: { PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const id = env.PROBE.idFromName("meta-probe");
    return env.PROBE.get(id).fetch(request);
  },
};
