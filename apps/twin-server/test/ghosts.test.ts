/**
 * Ghost lifecycle (twin_sync semantics): synthetic detections → spawn,
 * interpolation toward the next fix, 12 s expiry, and TruthFrame presence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TruthStreamClient, type TruthFrame } from '@simforge-oss/training-env';
import { GhostMirror, type DetectionRecord } from '../src/ghosts.js';
import { wgs84FromScene } from '../src/geo.js';
import { testWorld } from './helpers.js';
import type { TwinWorld } from '../src/world.js';

function detection(world: TwinWorld, objectId: string, x: number, z: number, extra: Partial<DetectionRecord> = {}): DetectionRecord {
  const gps = wgs84FromScene(world.frame, { x, z });
  return {
    object_id: objectId,
    object_type: 'car',
    gps_location: { lat: gps.lat, lon: gps.lon },
    confidence: 0.9,
    ...extra,
  };
}

describe('ghost lifecycle', () => {
  it('spawns from a detection, interpolates toward the next fix, expires after 12 s', async () => {
    const world = await testWorld();
    const mirror = new GhostMirror(world, 12);
    const sub = world.session.subscribeTruth({ capacity: 512 });
    const truth = new TruthStreamClient();
    const frames: TruthFrame[] = [];
    const drain = () => {
      for (const bytes of sub.drain()) for (const frame of truth.push(bytes)) frames.push(frame);
    };

    // t0: first fix at an off-road point near the origin → spawn.
    let now = 1_000_000;
    mirror.ingest([detection(world, 'obj-1', 20, 20)], now);
    const track = mirror.tracks.get('obj-1');
    expect(track).toBeDefined();
    expect(track!.actorId).not.toBeNull();
    const ghostId = track!.actorId!;

    world.session.advance(2);
    drain();
    // Ghost MUST appear in the TruthFrame with its semantic class.
    const spawned = frames.at(-1)!.actors.find((a) => a.id === ghostId);
    expect(spawned).toBeDefined();
    expect(spawned!.class).toBe('car');
    const sceneActor = frames.at(-1)!.scene.actors.find((a) => a.id === ghostId)!;
    expect(sceneActor.position[0]).toBeCloseTo(20, 0);
    expect(sceneActor.position[2]).toBeCloseTo(20, 0);

    // t0+1: the object is now reported 8 m east (a live feed repeats the fix
    // every poll) → the ghost chases it with the engine's dynamic body.
    // Assert monotone progress toward the fix over 2 s.
    now += 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    let wall = 5_000_000;
    const progressAt: number[] = [];
    for (let step = 0; step < 40; step++) {
      wall += world.dt * 1000;
      vi.setSystemTime(wall);
      if (step % 2 === 0) mirror.ingest([detection(world, 'obj-1', 28, 20)], now);
      mirror.drive();
      world.session.advance(1);
      drain();
      if (step % 10 === 9) {
        const at = frames.at(-1)!.scene.actors.find((a) => a.id === ghostId)!;
        progressAt.push(at.position[0] - 20);
      }
    }
    vi.useRealTimers();
    expect(progressAt[3]!).toBeGreaterThan(4); // well on the way to x=28
    expect(progressAt[3]!).toBeGreaterThan(progressAt[0]!); // monotone chase
    const settled = frames.at(-1)!.scene.actors.find((a) => a.id === ghostId)!;
    expect(Math.abs(settled.position[2] - 20)).toBeLessThan(1.5);

    // Expiry: 12 s without a sighting → despawn (twin_sync despawn_after).
    mirror.expire(now + 12.0); // exactly at the boundary: still alive
    expect(mirror.tracks.has('obj-1')).toBe(true);
    mirror.expire(now + 12.1); // past the boundary: dropped
    expect(mirror.tracks.has('obj-1')).toBe(false);
    world.session.advance(2);
    drain();
    const finalFrame = frames.at(-1)!;
    expect(finalFrame.actors.find((a) => a.id === ghostId)).toBeUndefined();
  });

  it('ignores non-mirrorable object types and incomplete records', async () => {
    const world = await testWorld();
    const mirror = new GhostMirror(world, 12);
    mirror.ingest(
      [
        detection(world, 'bike-1', 5, 5, { object_type: 'bicycle' }),
        { object_id: 'no-gps', object_type: 'car' },
        { object_id: '', object_type: 'car', gps_location: { lat: 37.9155, lon: -122.3335 } },
      ],
      1_000,
    );
    expect(mirror.tracks.size).toBe(0);
  });

  it('mirrors person detections as pedestrians', async () => {
    const world = await testWorld();
    const mirror = new GhostMirror(world, 12);
    mirror.ingest([detection(world, 'ped-1', 12, -12, { object_type: 'person' })], 2_000);
    const track = mirror.tracks.get('ped-1');
    expect(track?.actorId).not.toBeNull();
    const meta = world.meta.get(track!.actorId!);
    expect(meta?.kind).toBe('pedestrian');
  });

  it('uses detection time for replay expiry and holds actors still while paused', async () => {
    const world = await testWorld();
    const mirror = new GhostMirror(world, 12);
    const replayEpoch = 1_756_000_000;
    mirror.ingest([
      detection(world, 'replay-car', 40, 40, { timestamp_utc: new Date(replayEpoch * 1000).toISOString() }),
    ], replayEpoch, { useDetectionTs: true });
    const track = mirror.tracks.get('replay-car')!;
    mirror.setPaused(true);
    const actorId = track.actorId!;
    const before = world.actorState(actorId)!;
    for (let step = 0; step < 40; step++) {
      mirror.drive();
      world.session.advance(1);
    }
    const after = world.actorState(actorId)!;
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.z).toBeCloseTo(before.z, 3);
    mirror.expire(replayEpoch + 12);
    expect(mirror.tracks.has('replay-car')).toBe(true);
    mirror.expire(replayEpoch + 12.1);
    expect(mirror.tracks.has('replay-car')).toBe(false);
  });

  describe('settling on a jittered fix', () => {
    afterEach(() => vi.useRealTimers());

    // Monocular fixes jump ~1-3 m between frames; the mirror must settle, not orbit.
    // `fixAt(t)` is the fix offset from (20, 20) reported at simulated second t.
    async function settle(objectType: string, fixAt: (t: number) => { x: number; z: number }, steps = 200) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const world = await testWorld();
      const mirror = new GhostMirror(world, 12);
      const report = (t: number) => {
        const f = fixAt(t);
        mirror.ingest([detection(world, 'jit', 20 + f.x, 20 + f.z, { object_type: objectType })], now);
      };
      let now = 3_000;
      vi.setSystemTime(now * 1000);
      mirror.ingest([detection(world, 'jit', 20, 20, { object_type: objectType })], now);
      const actorId = mirror.tracks.get('jit')!.actorId!;
      world.session.advance(10);
      let path = 0;
      let turned = 0;
      let prev = world.actorState(actorId)!;
      for (let step = 0; step < steps; step++) {
        const t = step * world.dt;
        now += world.dt;
        vi.setSystemTime(now * 1000);
        if (step % 4 === 0) report(t);
        mirror.drive();
        world.session.advance(1);
        const cur = world.actorState(actorId)!;
        path += Math.hypot(cur.x - prev.x, cur.z - prev.z);
        turned += Math.abs(Math.atan2(Math.sin(cur.headingRad - prev.headingRad), Math.cos(cur.headingRad - prev.headingRad)));
        prev = cur;
      }
      return { path, turnedDeg: (turned * 180) / Math.PI, speed: prev.speedMps, at: { x: prev.x - 20, z: prev.z - 20 }, elapsedS: steps * world.dt };
    }
    const missFrom = (r: { at: { x: number; z: number } }, p: { x: number; z: number }) => Math.hypot(r.at.x - p.x, r.at.z - p.z);

    it('a pedestrian walks to a fix beside it and stops', async () => {
      const r = await settle('person', () => ({ x: 0, z: 2 }));
      expect(missFrom(r, { x: 0, z: 2 })).toBeLessThan(1);
      expect(r.path).toBeLessThan(4);
      expect(r.turnedDeg).toBeLessThan(360);
      expect(r.speed).toBeLessThan(0.3);
    });

    it('a pedestrian walks back to a fix behind it and stops', async () => {
      const r = await settle('person', () => ({ x: -2, z: 0 }));
      expect(missFrom(r, { x: -2, z: 0 })).toBeLessThan(1);
      expect(r.path).toBeLessThan(4);
      expect(r.turnedDeg).toBeLessThan(360);
    });

    it('a car holds instead of circling a fix inside its turning radius', async () => {
      const r = await settle('car', () => ({ x: 0, z: 2 }));
      expect(r.path).toBeLessThan(4);
      expect(r.turnedDeg).toBeLessThan(90);
      expect(r.speed).toBeLessThan(0.3);
    });

    it('a standing pedestrian with fixes jittering 1.5 m either side stays put', async () => {
      const r = await settle('person', (t) => ({ x: 0, z: Math.round(t / 0.2) % 2 === 0 ? 1.5 : -1.5 }));
      expect(r.path).toBeLessThan(2);
      expect(r.turnedDeg).toBeLessThan(180);
    });

    it('a walking pedestrian with lateral jitter follows without zigzagging', async () => {
      const jitter = [0.9, -1.1, 0.4, -0.7, 1.2, -0.3, 0.8, -1.0];
      const r = await settle('person', (t) => ({ x: 1.4 * t, z: jitter[Math.round(t / 0.2) % jitter.length]! }), 300);
      const truth = { x: 1.4 * r.elapsedS, z: 0 };
      expect(missFrom(r, truth)).toBeLessThan(2.5);
      expect(r.turnedDeg).toBeLessThan(270);
    });
  });

  it('a car detected moving down a lane spawns facing along it and follows without swerving', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const world = await testWorld();
      const graph = world.bundle.graph;
      const rsl = graph.laneRsls().find((r) => {
        const geom = graph.geometry(r);
        return geom && geom.lane.laneType === 'driving' && !geom.lane.isJunction && geom.lengthM > 80;
      })!;
      const reversed = graph.nominalReversed(rsl) ?? false;
      const along = (s: number) => {
        const sample = graph.sampleDirected({ rsl, reversed }, s);
        return { x: sample.point.x, z: -sample.point.y, headingRad: sample.headingRad };
      };
      const mirror = new GhostMirror(world, 12);
      let now = 4_000;
      const speedMps = 8;
      const report = (t: number) => {
        const p = along(10 + speedMps * t);
        mirror.ingest([detection(world, 'lane-car', p.x, p.z)], now);
      };
      vi.setSystemTime(now * 1000);
      report(0);
      const actorId = mirror.tracks.get('lane-car')!.actorId!;
      const spawned = world.actorState(actorId)!;
      const laneHeading = along(10).headingRad;
      expect(Math.abs(Math.atan2(Math.sin(spawned.headingRad - laneHeading), Math.cos(spawned.headingRad - laneHeading)))).toBeLessThan(0.2);
      let turned = 0;
      let prev = spawned;
      const steps = Math.round(6 / world.dt);
      for (let step = 1; step <= steps; step++) {
        now += world.dt;
        vi.setSystemTime(now * 1000);
        if (step % 2 === 0) report(step * world.dt);
        mirror.drive();
        world.session.advance(1);
        const cur = world.actorState(actorId)!;
        turned += Math.abs(Math.atan2(Math.sin(cur.headingRad - prev.headingRad), Math.cos(cur.headingRad - prev.headingRad)));
        prev = cur;
      }
      const truth = along(10 + speedMps * steps * world.dt);
      expect(Math.hypot(prev.x - truth.x, prev.z - truth.z)).toBeLessThan(4);
      expect(Math.abs(Math.atan2(Math.sin(prev.headingRad - truth.headingRad), Math.cos(prev.headingRad - truth.headingRad)))).toBeLessThan(0.3);
      expect((turned * 180) / Math.PI).toBeLessThan(90);
    } finally {
      vi.useRealTimers();
    }
  });
});
