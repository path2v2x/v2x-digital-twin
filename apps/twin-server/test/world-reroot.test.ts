/**
 * Long-lived worlds re-root onto a fresh engine session so spawn cost does not
 * grow with uptime; present actors, ids, motion and the truth stream survive.
 */
import { describe, expect, it } from 'vitest';
import { TruthStreamClient, type TruthFrame } from '@simforge-oss/training-env';
import { testConfig, testWorld } from './helpers.js';

describe('session re-rooting', () => {
  it('carries present actors onto a fresh session with continuous time and truth', async () => {
    const world = await testWorld(testConfig({ sessionEpochSeconds: 2 }));
    const truth = new TruthStreamClient();
    const frames: TruthFrame[] = [];
    world.subscribe((bytes) => frames.push(...truth.push(bytes)));

    const ghost = world.spawnFreeform({ category: 'ghost', kind: 'car', blueprint: 'twin.car', pose: { x: 20, z: 20, headingRad: 0 } });
    const gone = world.spawnFreeform({ category: 'ghost', kind: 'pedestrian', blueprint: 'twin.person', pose: { x: 40, z: 40, headingRad: 0 } });
    expect(ghost.ok && gone.ok).toBe(true);
    if (!ghost.ok || !gone.ok) return;
    world.despawn(gone.id);
    world.actChase(ghost.id, { x: 30, z: 20 }, 3);

    const sessionBefore = world.session;
    let lastTime = world.time();
    let lastX = world.actorState(ghost.id)!.x;
    for (let tick = 0; tick < 60; tick += 1) {
      world.advanceTicks(1);
      expect(world.time()).toBeGreaterThan(lastTime);
      lastTime = world.time();
      const state = world.actorState(ghost.id);
      expect(state, `ghost missing at tick ${tick}`).toBeDefined();
      expect(Math.abs(state!.x - lastX)).toBeLessThan(0.5);
      lastX = state!.x;
    }

    expect(world.session).not.toBe(sessionBefore);
    expect(world.session.time()).toBeLessThan(2);
    expect(lastTime).toBeGreaterThan(2.9);
    // The chase act survived the re-root: the ghost kept closing on its target.
    expect(lastX).toBeGreaterThan(22);
    expect(world.meta.get(ghost.id)?.category).toBe('ghost');
    expect(world.meta.has(gone.id)).toBe(false);

    // Truth kept flowing from the new session, whose tick count restarted.
    const latest = frames.at(-1)!;
    expect(latest.tick).toBeLessThan(Math.max(...frames.map((frame) => frame.tick)));
    expect(latest.actors.map((actor) => actor.id)).toContain(ghost.id);

    const fresh = world.spawnFreeform({ category: 'ghost', kind: 'car', blueprint: 'twin.car', pose: { x: 60, z: 60, headingRad: 0 } });
    expect(fresh.ok && fresh.id).not.toBe(gone.id);
    expect(fresh.ok && fresh.id).not.toBe(ghost.id);
  });
});
