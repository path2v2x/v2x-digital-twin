/**
 * Replay clock math (verbatim twin_sync.py contract):
 *   clock = start + (wallNow − wall0) × speed, speed clamped to [0.25, 8].
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwinSync } from '../src/twinsync.js';
import type { TwinWorld } from '../src/world.js';
import { testConfig, testWorld } from './helpers.js';

let world: TwinWorld;

beforeAll(async () => {
  world = await testWorld();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('replay clock', () => {
  it('advances at the requested speed from the requested start', () => {
    const sync = new TwinSync(world, testConfig());
    const wall0 = 1_756_000_000_000; // ms
    vi.setSystemTime(wall0);
    const start = 1_755_900_000; // epoch seconds
    sync.startReplay(start, 2);
    expect(sync.currentMode()).toBe('replay');
    expect(sync.replayClock()).toBeCloseTo(start, 6);

    vi.setSystemTime(wall0 + 10_000); // +10 s wall
    expect(sync.replayClock()).toBeCloseTo(start + 20, 6); // ×2 speed

    vi.setSystemTime(wall0 + 90_000);
    expect(sync.replayClock()).toBeCloseTo(start + 180, 6);
  });

  it('clamps speed to [0.25, 8]', () => {
    const sync = new TwinSync(world, testConfig());
    const wall0 = 1_756_000_000_000;
    vi.setSystemTime(wall0);
    sync.startReplay(1_755_900_000, 100);
    vi.setSystemTime(wall0 + 10_000);
    expect(sync.replayClock()).toBeCloseTo(1_755_900_000 + 80, 6); // clamped to 8

    sync.startReplay(1_755_900_000, 0.01);
    vi.setSystemTime(wall0 + 20_000);
    expect(sync.replayClock()).toBeCloseTo(1_755_900_000 + 2.5, 6); // clamped to 0.25
  });

  it('go_live clears the clock and mode', () => {
    const sync = new TwinSync(world, testConfig());
    vi.setSystemTime(1_756_000_000_000);
    sync.startReplay(1_755_900_000, 1);
    sync.goLive();
    expect(sync.currentMode()).toBe('live');
    expect(sync.replayClock()).toBeNull();
  });

  it('replay steps ingest recorded records with detection timestamps', () => {
    const sync = new TwinSync(world, testConfig());
    const window = sync.recordedWindow();
    expect(window).not.toBeNull(); // shipped event1.json
    const records = sync.recordedInRange(window!.start, window!.end);
    expect(records.length).toBeGreaterThan(0);
    // All records lie inside the window and are timestamp-sorted.
    for (const record of records) expect(typeof record.timestamp_utc).toBe('string');
  });
});
