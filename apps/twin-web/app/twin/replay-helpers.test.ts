import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_CLIP_MS,
  archiveClipAt,
  archiveListUrl,
  archiveVideoUrl,
  clipStartupLagSeconds,
  MAX_CLIP_LEAD_MS,
  parseArchiveSegments,
  resolveArchiveClip,
  coverageTrackBackground,
  latestActivityMs,
  shouldCorrectVideoDrift,
} from './replay-helpers';

describe('archive replay helpers', () => {
  const template = 'https://twin.example/archive/get?path={channel}&start={start}&duration={duration}&format=mp4';

  it('anchors a clip on the whole second where playback starts', () => {
    const clock = Date.parse('2026-09-02T12:07:31.250Z');
    expect(archiveClipAt(clock)).toEqual({
      startMs: Date.parse('2026-09-02T12:07:31.000Z'),
      endMs: Date.parse('2026-09-02T12:12:31.000Z'),
      startIso: '2026-09-02T12:07:31.000Z',
      durationSeconds: 300,
    });
    expect(archiveVideoUrl(template, 'ch1', archiveClipAt(clock)!))
      .toBe('https://twin.example/archive/get?path=ch1&start=2026-09-02T12%3A07%3A31.000Z&duration=300&format=mp4');
  });

  it('adds a fractional server offset to the archive clip request', () => {
    const clip = archiveClipAt(Date.parse('2026-09-02T12:02:31.250Z'))!;
    expect(archiveVideoUrl(template, 'ch1', clip, 2.6))
      .toBe('https://twin.example/archive/get?path=ch1&start=2026-09-02T12%3A02%3A33.600Z&duration=300&format=mp4');
  });

  it('keeps the clip while the clock plays through it and re-anchors on seeks', () => {
    const start = Date.parse('2026-09-02T12:00:00.000Z');
    const clip = archiveClipAt(start)!;
    expect(resolveArchiveClip(clip, start, start + 250, 1)).toBe(clip);
    expect(resolveArchiveClip(clip, start, start + 4 * 250, 4)).toBe(clip);
    expect(resolveArchiveClip(clip, start + 10_000, start + 10_000, 0)).toBe(clip);
    const seeked = resolveArchiveClip(clip, start + 10_000, start + 60_000, 1);
    expect(seeked!.startMs).toBe(start + 60_000);
    expect(resolveArchiveClip(clip, start + 10_000, start - 5_000, 1)!.startMs).toBe(start - 5_000);
    expect(resolveArchiveClip(clip, start + ARCHIVE_CLIP_MS - 250, start + ARCHIVE_CLIP_MS, 1)!.startMs)
      .toBe(start + ARCHIVE_CLIP_MS);
    expect(resolveArchiveClip(null, Number.NaN, start, 1)!.startMs).toBe(start);
  });

  it('leads a clip request by the measured start-up latency, capped', () => {
    const start = Date.parse('2026-09-02T12:00:00.000Z');
    expect(archiveClipAt(start, 4_300)!.startMs).toBe(start + 4_000);
    expect(archiveClipAt(start, 60_000)!.startMs).toBe(start + MAX_CLIP_LEAD_MS);
    expect(archiveClipAt(start, -5)!.startMs).toBe(start);
    const led = archiveClipAt(start, 4_000)!;
    // The clock is briefly behind a led clip; that is not a reason to re-anchor.
    expect(resolveArchiveClip(led, start, start + 250, 1)).toBe(led);
    expect(clipStartupLagSeconds(archiveClipAt(start)!, start + 9_000, 1.2)).toBeCloseTo(7.8);
    expect(clipStartupLagSeconds(archiveClipAt(start)!, start + 1_000, 3)).toBe(0);
  });

  it('corrects only drift beyond half a second', () => {
    expect(shouldCorrectVideoDrift(31, 31.5)).toBe(false);
    expect(shouldCorrectVideoDrift(31, 31.501)).toBe(true);
    expect(shouldCorrectVideoDrift(Number.NaN, 31)).toBe(true);
  });
});

describe('segment-aware archive clips', () => {
  const at = (iso: string) => Date.parse(iso);
  // Recorder resets leave gaps; the second segment starts on a fractional second.
  const segments = [
    { startMs: at('2026-09-24T11:10:20.000Z'), endMs: at('2026-09-24T11:11:54.000Z') },
    { startMs: at('2026-09-24T11:12:08.400Z'), endMs: at('2026-09-24T11:13:43.000Z') },
  ];

  it('yields no clip while the clock is in a recording gap', () => {
    expect(archiveClipAt(at('2026-09-24T11:12:00.000Z'), 0, segments)).toBeNull();
    expect(resolveArchiveClip(null, Number.NaN, at('2026-09-24T11:12:00.000Z'), 1, 0, segments)).toBeNull();
  });

  it('starts a clip at least a second inside a segment that begins mid-second', () => {
    const clip = archiveClipAt(at('2026-09-24T11:12:08.000Z'), 0, segments)!;
    expect(clip.startIso).toBe('2026-09-24T11:12:10.000Z');
    expect(archiveClipAt(at('2026-09-24T11:12:30.600Z'), 0, segments)!.startIso).toBe('2026-09-24T11:12:30.000Z');
  });

  it('ends a clip with its segment and moves to the next segment after the gap', () => {
    const first = archiveClipAt(at('2026-09-24T11:11:00.000Z'), 0, segments)!;
    expect(first.endMs).toBe(at('2026-09-24T11:11:54.000Z'));
    expect(first.durationSeconds).toBe(54);
    expect(resolveArchiveClip(first, at('2026-09-24T11:11:53.500Z'), at('2026-09-24T11:11:54.000Z'), 1, 0, segments)).toBeNull();
    expect(resolveArchiveClip(null, at('2026-09-24T11:12:08.500Z'), at('2026-09-24T11:12:09.500Z'), 1, 0, segments)!.startIso)
      .toBe('2026-09-24T11:12:10.000Z');
  });

  it('does not request a sliver at the very end of a segment', () => {
    expect(archiveClipAt(at('2026-09-24T11:11:53.000Z'), 0, segments)).toBeNull();
  });

  it('parses a MediaMTX listing into replay-clock segments and builds the list URL', () => {
    const body = [{ start: '2026-09-24T11:12:08.4Z', duration: 94.6, url: 'ignored' }];
    expect(parseArchiveSegments(body, 2)).toEqual([
      { startMs: at('2026-09-24T11:12:06.400Z'), endMs: at('2026-09-24T11:13:41.000Z') },
    ]);
    expect(parseArchiveSegments({ error: 'nope' })).toBeNull();
    expect(archiveListUrl('https://t/archive/list?path={channel}&start={start}&end={end}', 'ch1', at('2026-09-24T11:00:00Z'), at('2026-09-24T11:10:00Z'), 2))
      .toBe('https://t/archive/list?path=ch1&start=2026-09-24T11%3A00%3A02.000Z&end=2026-09-24T11%3A10%3A02.000Z');
  });
});

describe('coverage paint', () => {
  it('maps empty and active five-minute buckets onto the range track', () => {
    const start = Date.parse('2026-09-02T12:00:00Z');
    const buckets = [
      { start: new Date(start).toISOString(), detections: 0, objects: 0 },
      { start: new Date(start + ARCHIVE_CLIP_MS).toISOString(), detections: 5, objects: 3 },
    ];
    const paint = coverageTrackBackground(buckets, start, start + 2 * ARCHIVE_CLIP_MS);
    expect(paint).toContain('hsl(var(--muted)) 0.000%');
    expect(paint).toContain('hsl(var(--primary) / 1.000) 50.000%');
    expect(paint).toContain('100.000%');
    expect(latestActivityMs(buckets)).toBe(start + ARCHIVE_CLIP_MS);
  });
});
