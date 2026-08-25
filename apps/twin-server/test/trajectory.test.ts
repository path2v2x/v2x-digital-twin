/**
 * Trajectory playback: actors hit recorded GPS keyframes at recorded
 * timestamps. Tolerance: one engine tick (50 ms) of keyframe segment speed —
 * asserted here as <= 0.75 m for <= 15 m/s segments (documented in
 * docs/twin-protocol-v2.md).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP_ROOT } from '../src/config.js';
import { wgs84FromScene } from '../src/geo.js';
import { parseTrajectory } from '../src/trajectory.js';
import type { TwinWorld } from '../src/world.js';
import { testWorld } from './helpers.js';

const TOLERANCE_M = 0.75;

let world: TwinWorld;

beforeAll(async () => {
  world = await testWorld();
});

describe('trajectory parsing (both v1 formats)', () => {
  it('parses the shipped V2X detection list (event1.json) like trajectory_player.py', () => {
    const raw: unknown = JSON.parse(readFileSync(path.join(APP_ROOT, 'assets', 'trajectories', 'event1.json'), 'utf8'));
    const parsed = parseTrajectory('event1.json', raw, world);
    expect(parsed.points.length).toBeGreaterThanOrEqual(2);
    expect(parsed.points[0]!.t).toBe(0);
    for (let i = 1; i < parsed.points.length; i++) {
      expect(parsed.points[i]!.t).toBeGreaterThanOrEqual(parsed.points[i - 1]!.t);
    }
  });

  it('parses the simple {t, lat, lon} format and normalises t to zero', () => {
    const a = wgs84FromScene(world.frame, { x: 0, z: 0 });
    const b = wgs84FromScene(world.frame, { x: 10, z: 0 });
    const parsed = parseTrajectory('simple', [
      { t: 5, lat: a.lat, lon: a.lon },
      { t: 7, lat: b.lat, lon: b.lon },
    ], world);
    expect(parsed.points.map((p) => p.t)).toEqual([0, 2]);
    expect(parsed.points[1]!.x).toBeCloseTo(10, 3);
  });

  it('rejects unrecognised formats', () => {
    expect(() => parseTrajectory('bad', [{ foo: 1 }], world)).toThrow('Unrecognised trajectory format');
    expect(() => parseTrajectory('bad', [], world)).toThrow('non-empty');
  });
});

describe('timed-route playback', () => {
  it('reaches every keyframe at its recorded timestamp within one tick of motion', () => {
    const keyframes = [
      { t: 0, x: 200, z: 200 },
      { t: 2, x: 210, z: 200 }, // 5 m/s east
      { t: 4, x: 210, z: 214 }, // 7 m/s north-ish
      { t: 6, x: 204, z: 214 }, // 3 m/s back west
    ];
    const spawned = world.spawnTimedRoute({
      category: 'trajectory',
      kind: 'car',
      blueprint: 'vehicle.tesla.model3',
      points: keyframes,
    });
    expect(spawned.ok).toBe(true);
    const id = spawned.ok ? spawned.id : '';
    const t0 = world.time() + world.dt; // spawnTimedRoute anchors keyframes here

    for (const key of keyframes) {
      const targetTime = t0 + key.t;
      const ticks = Math.round((targetTime - world.time()) / world.dt);
      if (ticks > 0) world.session.advance(ticks);
      const state = world.actorState(id);
      expect(state, `actor present at t=${key.t}`).toBeDefined();
      const error = Math.hypot(state!.x - key.x, state!.z - key.z);
      expect(error, `keyframe t=${key.t} error ${error.toFixed(3)} m`).toBeLessThanOrEqual(TOLERANCE_M);
    }

    // After the final keyframe the engine hands off to braking + idle (v1
    // brake-then-idle finish): the actor stays near the terminal keyframe.
    world.session.advance(40);
    const rest = world.actorState(id);
    expect(rest).toBeDefined();
    const drift = Math.hypot(rest!.x - 204, rest!.z - 214);
    expect(drift).toBeLessThanOrEqual(3);
    world.despawn(id);
  });
});
