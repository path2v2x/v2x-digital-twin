import { describe, expect, it } from 'vitest';

import { archiveListUrl, avcCodecFromInit, eventFootageWindow, footageUrl, MAX_WINDOW_MS, parseArchiveSegments, windowAround } from './archive';
import type { DetectionEvent } from '../twin/detection-events';

const at = (iso: string) => Date.parse(iso);
const event = (startIso: string, endIso: string): DetectionEvent => ({ id: 'e', kind: 'vehicle', startMs: at(startIso), endMs: at(endIso), objects: 1, detections: 20, cameras: ['ch4'] });

describe('footage windows', () => {
  it('loads a detection from its first second, at least the default window', () => {
    expect(eventFootageWindow(event('2026-10-21T21:53:15.400Z', '2026-10-21T21:53:23.700Z')))
      .toEqual({ startMs: at('2026-10-21T21:53:15Z'), endMs: at('2026-10-21T21:53:45Z') });
  });

  it('loads a longer detection whole, capped at the maximum window from its start', () => {
    expect(eventFootageWindow(event('2026-10-21T21:00:00.400Z', '2026-10-21T21:00:41.200Z')))
      .toEqual({ startMs: at('2026-10-21T21:00:00Z'), endMs: at('2026-10-21T21:00:42Z') });
    expect(eventFootageWindow(event('2026-10-21T21:00:00.400Z', '2026-10-21T21:05:00Z')))
      .toEqual({ startMs: at('2026-10-21T21:00:00Z'), endMs: at('2026-10-21T21:00:00Z') + MAX_WINDOW_MS });
  });

  it('starts a timeline-click window on the clicked whole second', () => {
    expect(windowAround(at('2026-10-21T21:00:10.900Z'))).toEqual({ startMs: at('2026-10-21T21:00:10Z'), endMs: at('2026-10-21T21:00:40Z') });
  });

  it('requests archive time (detection time plus offset) and the duration in seconds', () => {
    const access = { urlTemplate: 'https://t/archive/get?path={channel}&start={start}&duration={duration}&format=fmp4', listUrlTemplate: null, offsetSeconds: 6 };
    expect(footageUrl(access, 'ch4', { startMs: at('2026-10-21T21:53:10Z'), endMs: at('2026-10-21T21:53:29Z') }))
      .toBe('https://t/archive/get?path=ch4&start=2026-10-21T21%3A53%3A16.000Z&duration=19&format=fmp4');
  });
});

describe('archive listing', () => {
  it('parses a MediaMTX listing into detection-time segments and builds the list URL', () => {
    const body = [{ start: '2026-09-24T11:12:08.4Z', duration: 94.6, url: 'ignored' }];
    expect(parseArchiveSegments(body, 2)).toEqual([{ startMs: at('2026-09-24T11:12:06.400Z'), endMs: at('2026-09-24T11:13:41.000Z') }]);
    expect(parseArchiveSegments({ error: 'nope' })).toBeNull();
    expect(archiveListUrl('https://t/archive/list?path={channel}&start={start}&end={end}', 'ch1', at('2026-09-24T11:00:00Z'), at('2026-09-24T11:10:00Z'), 2))
      .toBe('https://t/archive/list?path=ch1&start=2026-09-24T11%3A00%3A02.000Z&end=2026-09-24T11%3A10%3A02.000Z');
  });
});

describe('avcCodecFromInit', () => {
  it('reads profile, compatibility and level from the avcC box', () => {
    const box = [...'....avcC'].map((c) => c.charCodeAt(0));
    expect(avcCodecFromInit(new Uint8Array([...box, 0x01, 0x64, 0x00, 0x20, 0xff]))).toBe('avc1.640020');
  });

  it('waits for more bytes when the box is cut off or absent', () => {
    const box = [...'....avcC'].map((c) => c.charCodeAt(0));
    expect(avcCodecFromInit(new Uint8Array([...box, 0x01, 0x64]))).toBeNull();
    expect(avcCodecFromInit(new Uint8Array([0x66, 0x74, 0x79, 0x70]))).toBeNull();
  });
});
