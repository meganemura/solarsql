// Fixture Worker: pins Miniflare's local behavior for a Durable Object's
// Point-in-Time Recovery (PITR) API, for
// skills/solarsql/references/migrations.md's "Take a restore point before a
// remote migration" section. getCurrentBookmark() resolves locally (a
// counter-shaped bookmark); getBookmarkForTime() and
// onNextSessionRestoreBookmark() reject, because Miniflare does not store
// the durable log of data changes PITR needs. Structural casts only, the
// same shape test/durable-alarm.worker.ts uses for the alarm API: no
// @cloudflare/workers-types, no change to example/cloudflare.d.ts.
import { DurableObject } from "cloudflare:workers";

type PitrStorage = {
  getCurrentBookmark(): Promise<string>;
  getBookmarkForTime(timestamp: number): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
  put(key: string, value: unknown): Promise<void>;
};

export class PitrProbe extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage as unknown as PitrStorage;
    const path = new URL(request.url).pathname;

    if (path === "/two-bookmarks") {
      const first = await storage.getCurrentBookmark();
      await storage.put("probe", 1);
      const second = await storage.getCurrentBookmark();
      return Response.json({ first, second });
    }

    if (path === "/get-bookmark-for-time") {
      try {
        const bookmark = await storage.getBookmarkForTime(Date.now() / 1000);
        return Response.json({ ok: true, bookmark });
      } catch (e) {
        return Response.json({ ok: false, message: (e as Error).message });
      }
    }

    if (path === "/restore-bookmark") {
      try {
        const bookmark = await storage.onNextSessionRestoreBookmark("00000000-00000000-00000000-00000000000000000000000000000000");
        return Response.json({ ok: true, bookmark });
      } catch (e) {
        return Response.json({ ok: false, message: (e as Error).message });
      }
    }

    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: { PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const id = env.PROBE.idFromName("pitr-probe");
    const stub = env.PROBE.get(id);
    return stub.fetch(request);
  },
};
