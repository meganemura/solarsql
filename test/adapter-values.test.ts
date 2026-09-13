// Responsibility: test Cloudflare BLOB normalization before JSON decoding.
// Boundary: local Miniflare evidence; deployed behavior needs the remote suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { workerMiniflare } from './worker.ts';
import { parseJson } from '../src/runtime/plan.ts';
import { test as property } from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';

test('BLOB conversion preserves bytes and JSON arrays', () => {
  property(tc => {
    const bytes = Uint8Array.from(tc.draw(gs.binary()));
    const values = tc.draw(gs.arrays(gs.integers()));
    for (const format of ['native', 'd1'] as const) {
      const raw = format === 'native' ? Uint8Array.from(bytes).buffer : Array.from(bytes);
      assert.deepEqual(parseJson([{ raw, json: JSON.stringify(values), nullable: null }], ['json'], format), [{ raw: bytes, json: values, nullable: null }]);
    }
  });
});

test('local D1 and Durable Objects return Uint8Array and decoded JSON', async t => {
  const root = resolve(import.meta.dirname, '..');
  const mf = workerMiniflare(resolve(root, 'test/value-worker.ts'), root, { durableObjects: { VALUES: 'Values' } });
  t.after(() => mf.dispose());
  for (const path of ['/', '/do']) {
    const response = await mf.dispatchFetch(`http://localhost${path}`);
    assert.deepEqual(await response.json(), { bytes: [0,255], typed: true, empty: null, n: Number.MAX_SAFE_INTEGER, items: [1,2], batchTyped: true });
  }
});
