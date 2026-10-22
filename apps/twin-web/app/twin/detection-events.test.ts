import { describe, expect, it } from 'vitest';

import { eventWindow, parseDetectionEvents, type DetectionEvent } from './detection-events';

const bounds = { startMs: 0, endMs: 1_000_000 };
const event = (id: string, startMs: number, endMs: number): DetectionEvent => ({ id, kind: 'pedestrian', startMs, endMs, objects: 1, detections: 10, cameras: ['ch3'] });

describe('eventWindow', () => {
  it('takes an event exactly, with no padding', () => {
    expect(eventWindow(event('a', 100_000, 120_000), 60_000)).toEqual({ startMs: 100_000, endMs: 120_000 });
  });

  it('takes the first maximum window of a long event, from its start', () => {
    expect(eventWindow(event('b', 100_000, 400_000), 60_000)).toEqual({ startMs: 100_000, endMs: 160_000 });
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
