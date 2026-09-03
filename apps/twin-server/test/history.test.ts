import { afterEach, describe, expect, it } from 'vitest';
import { DetectionHistory } from '../src/history.js';

let stores: DetectionHistory[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function history(retentionHours = 72): DetectionHistory {
  const store = new DetectionHistory(':memory:', retentionHours);
  stores.push(store);
  return store;
}

function detection(objectId: string, lat = 37.9156, lon = -122.3338) {
  return {
    object_id: objectId,
    object_type: 'car',
    confidence: 0.9,
    gps_location: { lat, lon },
  };
}

describe('DetectionHistory', () => {
  it('records each camera frame once and returns timestamp-ordered ranges', () => {
    const store = history();
    const base = 1_756_000_000;
    expect(store.recordSummary('ch2', base + 2, [detection('third')])).toBe(true);
    expect(store.recordSummary('ch1', base, [detection('first')])).toBe(true);
    expect(store.recordSummary('ch1', base + 1, [detection('second')])).toBe(true);
    expect(store.recordSummary('ch1', base, [detection('duplicate')])).toBe(false);

    const page = store.range(base * 1000, (base + 3) * 1000, 2);
    expect(page.items.map((item) => item.object_id)).toEqual(['first', 'second']);
    expect(page.next).toBe(new Date((base + 2) * 1000).toISOString());
    expect(store.range(base * 1000, (base + 3) * 1000, 10).items.map((item) => item.object_id))
      .toEqual(['first', 'second', 'third']);
  });

  it('returns every requested bucket, including empty buckets', () => {
    const store = history();
    const baseMs = 1_756_000_000_000;
    store.recordSummary('ch1', baseMs / 1000 + 1, [detection('a'), detection('b')]);
    store.recordSummary('ch2', baseMs / 1000 + 11, [detection('a')]);

    expect(store.coverage(baseMs, baseMs + 30_000, 10)).toEqual([
      { start: new Date(baseMs).toISOString(), detections: 2, objects: 2 },
      { start: new Date(baseMs + 10_000).toISOString(), detections: 1, objects: 1 },
      { start: new Date(baseMs + 20_000).toISOString(), detections: 0, objects: 0 },
    ]);
  });

  it('summarises objects newest-last-seen first with their latest position', () => {
    const store = history();
    const baseMs = 1_756_000_000_000;
    store.recordSummary('ch1', baseMs / 1000 + 1, [detection('car-a', 37.1, -122.1), detection('car-b')]);
    store.recordSummary('ch2', baseMs / 1000 + 5, [detection('car-a', 37.2, -122.2)]);
    store.recordSummary('ch1', baseMs / 1000 + 3, [detection('car-b')]);

    const items = store.objects(baseMs, baseMs + 10_000, 10);
    expect(items.map((item) => item.object_id)).toEqual(['car-a', 'car-b']);
    expect(items[0]).toEqual({
      object_id: 'car-a',
      object_type: 'car',
      first_seen: new Date(baseMs + 1000).toISOString(),
      last_seen: new Date(baseMs + 5000).toISOString(),
      count: 2,
      max_confidence: 0.9,
      cameras: ['ch1', 'ch2'],
      last_lat: 37.2,
      last_lon: -122.2,
    });
    expect(store.objects(baseMs, baseMs + 10_000, 1).map((item) => item.object_id)).toEqual(['car-a']);
  });

  it('prunes detections and frame dedupe keys at the retention boundary', () => {
    const store = history(1);
    const nowMs = 1_756_010_000_000;
    const oldSec = (nowMs - 3_600_001) / 1000;
    const keptSec = (nowMs - 3_600_000) / 1000;
    store.recordSummary('ch1', oldSec, [detection('old')]);
    store.recordSummary('ch1', keptSec, [detection('kept')]);

    store.prune(nowMs);
    const page = store.range(nowMs - 4_000_000, nowMs + 1, 10);
    expect(page.items.map((item) => item.object_id)).toEqual(['kept']);
    expect(store.recordSummary('ch1', oldSec, [detection('old-again')])).toBe(true);
  });
});
