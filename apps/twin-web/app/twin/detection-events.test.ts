import { describe, expect, it } from 'vitest';

import { eventWindow, packEventLanes, parseDetectionEvents, type DetectionEvent } from './detection-events';

const bounds = { startMs: 0, endMs: 1_000_000 };
const event = (id: string, startMs: number, endMs: number): DetectionEvent => ({ id, kind: 'pedestrian', startMs, endMs, objects: 1, detections: 10, cameras: ['ch3'] });

describe('eventWindow', () => {
  it('takes a short event whole, padded by 2 s', () => {
    expect(eventWindow(event('a', 100_000, 120_000), 110_000, 60_000, bounds)).toEqual({ startMs: 98_000, endMs: 122_000 });
  });

  it('centres the maximum window on the click inside a long event, without leaving it', () => {
    const long = event('b', 100_000, 400_000);
    expect(eventWindow(long, 250_000, 60_000, bounds)).toEqual({ startMs: 220_000, endMs: 280_000 });
    expect(eventWindow(long, 101_000, 60_000, bounds)).toEqual({ startMs: 98_000, endMs: 158_000 });
    expect(eventWindow(long, 399_000, 60_000, bounds)).toEqual({ startMs: 342_000, endMs: 402_000 });
  });

  it('shifts inward rather than cutting the window at the retention and live edges', () => {
    expect(eventWindow(event('c', 500, 10_000), 1_000, 60_000, bounds)).toEqual({ startMs: 0, endMs: 13_500 });
    expect(eventWindow(event('d', 990_000, 999_500), 995_000, 60_000, bounds)).toEqual({ startMs: 986_500, endMs: 1_000_000 });
  });
});

describe('packEventLanes', () => {
  it('stacks only overlapping events', () => {
    const lanes = packEventLanes([event('a', 0, 10), event('b', 5, 20), event('c', 30, 40), event('d', 12, 14)], 1);
    expect(Object.fromEntries(lanes)).toEqual({ a: 0, b: 1, d: 0, c: 0 });
  });
});

describe('parseDetectionEvents', () => {
  it('keeps well-formed events and drops unknown kinds', () => {
    const parsed = parseDetectionEvents({
      events: [
        { id: 'pedestrian-1', kind: 'pedestrian', start: '2026-09-28T21:00:00Z', end: '2026-09-28T21:00:05Z', objects: 2, detections: 40, cameras: [{ camera: 'ch3', detections: 30 }, { camera: 'ch4', detections: 10 }] },
        { id: 'x', kind: 'spaceship', start: '2026-09-28T21:00:00Z', end: '2026-09-28T21:00:05Z' },
      ],
    });
    expect(parsed).toEqual([{ id: 'pedestrian-1', kind: 'pedestrian', startMs: Date.parse('2026-09-28T21:00:00Z'), endMs: Date.parse('2026-09-28T21:00:05Z'), objects: 2, detections: 40, cameras: ['ch3', 'ch4'] }]);
  });
});
