/**
 * Ghost lifecycle (twin_sync semantics): synthetic detections → spawn,
 * interpolation toward the next fix, 12 s expiry, and TruthFrame presence.
 */
import { describe, expect, it } from 'vitest';
import { TruthStreamClient, type TruthFrame } from '@simforge/training-env';
import { GhostMirror, type DetectionRecord } from '../src/ghosts.js';
import { wgs84FromScene } from '../src/geo.js';
import { testWorld } from './helpers.js';
import type { TwinWorld } from '../src/world.js';

function detection(world: TwinWorld, objectId: string, x: number, z: number, extra: Partial<DetectionRecord> = {}): DetectionRecord {
  const gps = wgs84FromScene(world.frame, { x, z });
  return {
    object_id: objectId,
    object_type: 'car',
    gps_location: { latitude: gps.lat, longitude: gps.lon },
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
    mirror.ingest([detection(world, 'obj-1', 20, 20)], now, { lerpDuration: 1 });
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

    // t0+1: second fix 8 m east → the ghost chases it (engine dynamic body:
    // accel-limited ramp instead of v1's transform lerp — documented
    // divergence). Assert monotone progress toward the fix over 2 s.
    now += 1;
    mirror.ingest([detection(world, 'obj-1', 28, 20)], now, { lerpDuration: 1 });
    const progressAt: number[] = [];
    for (let step = 0; step < 4; step++) {
      mirror.drive();
      world.session.advance(10); // 0.5 s of sim each
      drain();
      const at = frames.at(-1)!.scene.actors.find((a) => a.id === ghostId)!;
      progressAt.push(at.position[0] - 20);
    }
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
        { object_id: '', object_type: 'car', gps_location: { latitude: 37.9155, longitude: -122.3335 } },
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
});
