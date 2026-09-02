/**
 * truth_frame relay byte-equality: the bytes handed to a WS sink must be the
 * verbatim framed messages of a direct engine subscription over the same
 * ticks (frozen truth-stream-wire contract: concurrent subscribers receive
 * byte-identical frames). Driven deterministically via advanceTicks — no
 * wall-clock loop.
 */
import { describe, expect, it } from 'vitest';
import { TruthStreamClient } from '@simforge-oss/training-env';
import { testWorld } from './helpers.js';

describe('truth relay', () => {
  it('relays byte-identical frames vs a direct WorldSession subscription', async () => {
    const world = await testWorld();

    const relayed: Uint8Array[] = [];
    const unsubscribe = world.subscribe((bytes) => relayed.push(bytes));
    const direct = world.session.subscribeTruth({ capacity: 512 });

    world.spawnFreeform({
      category: 'scenario',
      kind: 'car',
      blueprint: 'vehicle.tesla.model3',
      pose: { x: 5, z: 5, headingRad: 0.4 },
    });
    // The exact per-step path the live 20 Hz loop takes, without the timer.
    for (let step = 0; step < 12; step++) world.advanceTicks(2);
    const directFrames = direct.drain();
    unsubscribe();

    expect(relayed.length).toBe(24);
    expect(directFrames.length).toBe(relayed.length);
    for (let i = 0; i < relayed.length; i++) {
      expect(Buffer.compare(Buffer.from(relayed[i]!), Buffer.from(directFrames[i]!)), `frame ${i} byte-identical`).toBe(0);
    }

    // And the relayed bytes decode as monotone-tick TruthFrames.
    const client = new TruthStreamClient();
    let lastTick = -1;
    let decoded = 0;
    for (const bytes of relayed) {
      for (const frame of client.push(bytes)) {
        expect(frame.tick).toBeGreaterThan(lastTick);
        lastTick = frame.tick;
        expect(frame.scene.tick).toBe(frame.tick);
        decoded += 1;
      }
    }
    expect(decoded).toBe(24);
  });
});
