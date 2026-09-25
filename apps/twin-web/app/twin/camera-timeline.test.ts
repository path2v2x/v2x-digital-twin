import { describe, expect, it } from 'vitest';

import {
  chooseBucketSeconds,
  clampSelection,
  coverageWindow,
  densityAlpha,
  formatSelection,
  HOUR_MS,
  MAX_VIEW_SPAN_MS,
  MIN_VIEW_SPAN_MS,
  moveSelection,
  msToX,
  pan,
  rulerTicks,
  uncoveredRanges,
  xToMs,
  zoomAround,
} from './camera-timeline';

const at = (iso: string) => Date.parse(iso);
const utc = () => 0;
const now = at('2026-09-24T23:10:00Z');
const bounds = { startMs: now - 72 * HOUR_MS, endMs: now };

describe('timeline view', () => {
  it('keeps the anchor instant at the same screen position while zooming', () => {
    const view = { startMs: now - 30 * HOUR_MS, endMs: now - 26 * HOUR_MS };
    const anchor = view.startMs + 0.3 * (view.endMs - view.startMs);
    const width = 1_000;
    const x = msToX(anchor, view, width);
    for (const factor of [1.2, 1 / 1.2, 0.25, 2]) {
      const next = zoomAround(view, anchor, factor, bounds);
      expect(next.endMs - next.startMs).toBeCloseTo((view.endMs - view.startMs) * factor);
      expect(msToX(anchor, next, width)).toBeCloseTo(x);
      expect(xToMs(x, next, width)).toBeCloseTo(anchor);
    }
  });

  it('limits the span to 20 s … 12 h and to the bounds', () => {
    const view = { startMs: now - HOUR_MS, endMs: now - 30 * 60_000 };
    const tight = zoomAround(view, view.startMs + 10 * 60_000, 1e-6, bounds);
    expect(tight.endMs - tight.startMs).toBe(MIN_VIEW_SPAN_MS);
    const wide = zoomAround(view, view.startMs, 1e6, bounds);
    expect(wide.endMs - wide.startMs).toBe(MAX_VIEW_SPAN_MS);
    const short = { startMs: now - 3 * HOUR_MS, endMs: now };
    expect(zoomAround({ startMs: now - HOUR_MS, endMs: now }, now, 100, short)).toEqual(short);
  });

  it('slides a zoom-out at the edge back inside the bounds', () => {
    const view = { startMs: now - 10 * 60_000, endMs: now };
    const next = zoomAround(view, now - 60_000, 10, bounds);
    expect(next).toEqual({ startMs: now - 100 * 60_000, endMs: now });
  });

  it('pans by ±12 h and stops at either bound without changing the span', () => {
    const view = { startMs: now - 30 * HOUR_MS, endMs: now - 18 * HOUR_MS };
    expect(pan(view, 12 * HOUR_MS, bounds)).toEqual({ startMs: now - 18 * HOUR_MS, endMs: now - 6 * HOUR_MS });
    expect(pan(view, 24 * HOUR_MS, bounds)).toEqual({ startMs: now - 12 * HOUR_MS, endMs: now });
    const nearStart = { startMs: bounds.startMs + HOUR_MS, endMs: bounds.startMs + 13 * HOUR_MS };
    expect(pan(nearStart, -12 * HOUR_MS, bounds)).toEqual({ startMs: bounds.startMs, endMs: bounds.startMs + 12 * HOUR_MS });
    const latest = { startMs: now - 12 * HOUR_MS, endMs: now };
    expect(pan(latest, 12 * HOUR_MS, bounds)).toEqual(latest);
  });
});

describe('coverage buckets', () => {
  it('picks nice buckets at least 2 px wide and at least 1 s', () => {
    expect(chooseBucketSeconds(12 * HOUR_MS, 1_200)).toBe(120);
    expect(chooseBucketSeconds(20_000, 1_200)).toBe(1);
    expect(chooseBucketSeconds(10 * 60_000, 1_200)).toBe(1);
    expect(chooseBucketSeconds(60 * 60_000, 1_200)).toBe(10);
    for (const [span, width] of [[12 * HOUR_MS, 1_600], [3 * HOUR_MS, 900], [5 * 60_000, 2_560]] as const) {
      const bucket = chooseBucketSeconds(span, width);
      expect(Number.isInteger(bucket)).toBe(true);
      expect(width * bucket * 1_000 / span).toBeGreaterThanOrEqual(2);
    }
  });

  it('never asks for more than 2000 aligned buckets, even on very wide strips', () => {
    for (const span of [12 * HOUR_MS, 11 * HOUR_MS + 1_234, 40 * 60_000 + 7]) {
      const bucket = chooseBucketSeconds(span, 100_000);
      const window = coverageWindow({ startMs: now - span + 321, endMs: now + 321 }, bucket);
      expect((window.endMs - window.startMs) / (bucket * 1_000)).toBeLessThanOrEqual(2_000);
    }
  });

  it('aligns the request window outward to whole buckets', () => {
    expect(coverageWindow({ startMs: at('2026-09-24T23:08:07.5Z'), endMs: at('2026-09-24T23:09:01Z') }, 10))
      .toEqual({ startMs: at('2026-09-24T23:08:00Z'), endMs: at('2026-09-24T23:09:10Z') });
  });

  it('shades density on a log scale with empty buckets transparent', () => {
    expect(densityAlpha(0, 500)).toBe(0);
    expect(densityAlpha(500, 500)).toBeCloseTo(1);
    expect(densityAlpha(1, 500)).toBeGreaterThan(0.15);
    expect(densityAlpha(22, 500)).toBeGreaterThan(0.5);
  });
});

describe('ruler ticks', () => {
  it('labels hours on a 12 h view and the date at midnight', () => {
    const ticks = rulerTicks({ startMs: at('2026-09-24T14:30:00Z'), endMs: at('2026-09-25T02:30:00Z') }, 1_200, utc);
    expect(ticks[0]).toEqual({ ms: at('2026-09-24T15:00:00Z'), label: '15:00', major: false });
    expect(ticks).toHaveLength(12);
    expect(ticks.find((tick) => tick.major)).toEqual({ ms: at('2026-09-25T00:00:00Z'), label: 'Sep 25', major: true });
    expect(ticks.filter((tick) => tick.major)).toHaveLength(1);
  });

  it('uses 2 h steps when a 12 h view is narrow', () => {
    const ticks = rulerTicks({ startMs: at('2026-09-24T11:10:00Z'), endMs: at('2026-09-24T23:10:00Z') }, 500, utc);
    expect(ticks.map((tick) => tick.label)).toEqual(['12:00', '14:00', '16:00', '18:00', '20:00', '22:00']);
  });

  it('shows seconds on a one-minute view', () => {
    const ticks = rulerTicks({ startMs: at('2026-09-24T23:08:03Z'), endMs: at('2026-09-24T23:09:03Z') }, 1_200, utc);
    expect(ticks.slice(0, 3).map((tick) => tick.label)).toEqual(['23:08:05', '23:08:10', '23:08:15']);
    expect(ticks.every((tick) => tick.ms % 5_000 === 0)).toBe(true);
  });

  it('reaches 1 s steps at the tightest zoom on a wide strip', () => {
    const ticks = rulerTicks({ startMs: at('2026-09-24T23:08:00.5Z'), endMs: at('2026-09-24T23:08:20.5Z') }, 1_600, utc);
    expect(ticks).toHaveLength(20);
    expect(ticks[0]!.label).toBe('23:08:01');
  });

  it('aligns ticks to local time', () => {
    const plus530 = () => 5.5 * HOUR_MS;
    const ticks = rulerTicks({ startMs: at('2026-09-24T12:00:00Z'), endMs: at('2026-09-24T20:00:00Z') }, 800, plus530);
    expect(ticks[0]).toEqual({ ms: at('2026-09-24T12:30:00Z'), label: '18:00', major: false });
    expect(ticks.find((tick) => tick.major)).toEqual({ ms: at('2026-09-24T18:30:00Z'), label: 'Sep 25', major: true });
  });
});

describe('selection', () => {
  const max = 60_000;
  const anchor = now - HOUR_MS;

  it('follows the pointer forward and backward up to the maximum', () => {
    expect(clampSelection(anchor, anchor + 42_000, max, bounds)).toEqual({ startMs: anchor, endMs: anchor + 42_000 });
    expect(clampSelection(anchor, anchor + 5 * 60_000, max, bounds)).toEqual({ startMs: anchor, endMs: anchor + max });
    expect(clampSelection(anchor, anchor - 42_000, max, bounds)).toEqual({ startMs: anchor - 42_000, endMs: anchor });
    expect(clampSelection(anchor, anchor - 5 * 60_000, max, bounds)).toEqual({ startMs: anchor - max, endMs: anchor });
  });

  it('stays inside the bounds', () => {
    expect(clampSelection(now - 10_000, now + 30_000, max, bounds)).toEqual({ startMs: now - 10_000, endMs: now });
    expect(clampSelection(bounds.startMs + 5_000, bounds.startMs - 30_000, max, bounds))
      .toEqual({ startMs: bounds.startMs, endMs: bounds.startMs + 5_000 });
    expect(moveSelection({ startMs: now - 30_000, endMs: now - 10_000 }, 60_000, bounds)).toEqual({ startMs: now - 20_000, endMs: now });
  });

  it('formats the readout', () => {
    expect(formatSelection({ startMs: at('2026-09-24T23:08:10Z'), endMs: at('2026-09-24T23:08:52Z') }, utc))
      .toBe('23:08:10–23:08:52 · 42 s');
    expect(formatSelection({ startMs: at('2026-09-24T23:08:10Z'), endMs: at('2026-09-24T23:08:52.5Z') }, utc))
      .toBe('23:08:10–23:08:52 · 42.5 s');
  });
});

describe('recording gaps', () => {
  it('returns the parts of the view without a recording', () => {
    const view = { startMs: 0, endMs: 100 };
    expect(uncoveredRanges(view, [])).toEqual([view]);
    expect(uncoveredRanges(view, [{ startMs: 60, endMs: 80 }, { startMs: -10, endMs: 20 }, { startMs: 70, endMs: 90 }]))
      .toEqual([{ startMs: 20, endMs: 60 }, { startMs: 90, endMs: 100 }]);
    expect(uncoveredRanges(view, [{ startMs: -5, endMs: 120 }])).toEqual([]);
  });
});
