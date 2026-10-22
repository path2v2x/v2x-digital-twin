import { describe, expect, it } from 'vitest';

import { parseDetectionEvents } from './detection-events';

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
