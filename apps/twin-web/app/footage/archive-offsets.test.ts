import { describe, expect, it } from 'vitest';

import { measuredOffsetAt, parseOffsetRuns } from './archive-offsets';

const at = (iso: string) => Date.parse(iso);

describe('measured archive offsets', () => {
  const runs = parseOffsetRuns({
    runs: [
      { start: '2026-10-22T20:39:20Z', end: '2026-10-22T20:39:30Z', offset_seconds: 0.4 },
      { start: '2026-10-22T20:39:00Z', end: '2026-10-22T20:39:18Z', offset_seconds: 1.9 },
      { start: '2026-10-22T20:39:40Z', end: '2026-10-22T20:39:40Z', offset_seconds: 3 },
    ],
  });

  it('orders runs by start and drops empty ones', () => {
    expect(runs.map((run) => run.offsetSeconds)).toEqual([1.9, 0.4]);
  });

  it('takes the run covering the instant, the next run from its first second', () => {
    expect(measuredOffsetAt(runs, at('2026-10-22T20:39:00Z'))).toBe(1.9);
    expect(measuredOffsetAt(runs, at('2026-10-22T20:39:20Z'))).toBe(0.4);
  });

  it('bridges a short gap with the nearest run and gives up beyond 5 s', () => {
    expect(measuredOffsetAt(runs, at('2026-10-22T20:39:18.500Z'))).toBe(1.9);
    expect(measuredOffsetAt(runs, at('2026-10-22T20:39:19.800Z'))).toBe(0.4);
    expect(measuredOffsetAt(runs, at('2026-10-22T20:39:35Z'))).toBe(0.4);
    expect(measuredOffsetAt(runs, at('2026-10-22T20:39:35.001Z'))).toBeNull();
    expect(measuredOffsetAt([], at('2026-10-22T20:39:00Z'))).toBeNull();
  });
});
