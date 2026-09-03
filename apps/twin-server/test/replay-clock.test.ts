import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwinSync } from '../src/twinsync.js';
import type { TwinWorld } from '../src/world.js';
import { testConfig, testWorld } from './helpers.js';

let world: TwinWorld;
let instances: TwinSync[] = [];

beforeAll(async () => {
  world = await testWorld();
});

beforeEach(() => {
  vi.useFakeTimers();
  instances = [];
});

afterEach(() => {
  for (const sync of instances) sync.stop();
  vi.useRealTimers();
});

function createSync(): TwinSync {
  const sync = new TwinSync(world, testConfig());
  instances.push(sync);
  return sync;
}

function record(sync: TwinSync, ts: number, objectId: string): void {
  sync.history!.recordSummary('ch1', ts, [{
    object_id: objectId,
    object_type: 'car',
    confidence: 0.9,
    gps_location: { lat: 37.915601, lon: -122.3338 },
  }]);
}

describe('replay clock', () => {
  it('advances at the requested speed from the requested start', () => {
    const sync = createSync();
    const wall0 = 1_756_000_000_000;
    vi.setSystemTime(wall0);
    const start = 1_755_900_000;
    sync.startReplay(start, 2);
    expect(sync.currentMode()).toBe('replay');
    expect(sync.replayClock()).toBeCloseTo(start, 6);

    vi.setSystemTime(wall0 + 10_000);
    expect(sync.replayClock()).toBeCloseTo(start + 20, 6);
    vi.setSystemTime(wall0 + 90_000);
    expect(sync.replayClock()).toBeCloseTo(start + 180, 6);
  });

  it('clamps moving speeds and allows zero to pause the clock and ghosts', () => {
    const sync = createSync();
    const wall0 = 1_756_000_000_000;
    const start = 1_755_900_000;
    vi.setSystemTime(wall0);
    sync.startReplay(start, 100);
    vi.setSystemTime(wall0 + 10_000);
    expect(sync.replayClock()).toBeCloseTo(start + 80, 6);

    sync.startReplay(start, 0.01);
    vi.setSystemTime(wall0 + 20_000);
    expect(sync.replayClock()).toBeCloseTo(start + 2.5, 6);

    record(sync, start, 'paused');
    sync.startReplay(start, 0);
    expect(sync.mirror.tracks.has('paused')).toBe(true);
    vi.setSystemTime(wall0 + 3_600_000);
    sync.stepReplay();
    expect(sync.replayClock()).toBe(start);
    expect(sync.mirror.tracks.has('paused')).toBe(true);
    expect(sync.status().replay_speed).toBe(0);
  });

  it('seeks by clearing tracks and reconstructing the requested instant', () => {
    const sync = createSync();
    const first = 1_755_900_000;
    const second = first + 60;
    record(sync, first, 'first');
    record(sync, second, 'second');
    vi.setSystemTime(1_756_000_000_000);

    sync.startReplay(first, 0);
    expect([...sync.mirror.tracks.keys()]).toEqual(['first']);
    sync.startReplay(second, 0);
    expect([...sync.mirror.tracks.keys()]).toEqual(['second']);
  });

  it('loads advancing history in chunks and returns cleanly to live', () => {
    const sync = createSync();
    const start = 1_755_900_000;
    record(sync, start + 5, 'moving');
    const wall0 = 1_756_000_000_000;
    vi.setSystemTime(wall0);
    sync.startReplay(start, 1);
    vi.setSystemTime(wall0 + 6_000);
    sync.stepReplay();
    expect(sync.mirror.tracks.has('moving')).toBe(true);

    sync.goLive();
    expect(sync.currentMode()).toBe('live');
    expect(sync.replayClock()).toBeNull();
    expect(sync.status().replay_speed).toBe(1);
  });
});
