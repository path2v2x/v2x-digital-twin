export const ARCHIVE_CLIP_SECONDS = 300;
export const ARCHIVE_CLIP_MS = ARCHIVE_CLIP_SECONDS * 1_000;
export const VIDEO_DRIFT_LIMIT_SECONDS = 0.5;

export interface DetectionCoverageBucket {
  start: string;
  detections: number;
  objects: number;
}

export interface ArchiveClipWindow {
  startMs: number;
  endMs: number;
  startIso: string;
  durationSeconds: number;
}

/**
 * A clock sample that departs from the previous one by more than this (after
 * accounting for playback speed) is a seek, not playback.
 */
export const CLIP_SEEK_JUMP_MS = 2_000;

/**
 * Archive clips are anchored where playback (re)starts rather than on a fixed
 * grid: MediaMTX serves progressive MP4 without range support, so a clip can
 * only play from its beginning. Anchoring at the seek instant keeps the video
 * aligned with the replay clock from the first frame.
 */
/** Largest lead applied to a clip request to absorb start-up latency. */
export const MAX_CLIP_LEAD_MS = 15_000;
/** Start-up lag below this is accepted rather than re-requested. */
export const CLIP_LAG_TOLERANCE_SECONDS = 1.5;

/** A recorded span, in replay-clock milliseconds. */
export interface ArchiveSegment {
  startMs: number;
  endMs: number;
}

/**
 * Clips start at least this far inside a segment: the archive answers 404 for
 * a start in a recording gap, including a fraction of a second before the
 * segment's first frame.
 */
export const SEGMENT_START_MARGIN_MS = 1_000;
/** A clip shorter than this is not worth requesting; the clock waits for the next segment. */
export const MIN_CLIP_MS = 2_000;

/**
 * `leadMs` shifts the request ahead of the clock by the clip's measured
 * start-up latency so that, when the first frame arrives, it matches the clock.
 * With `segments`, the clip is placed inside the recording that covers the
 * target and ends with it; a target in a gap yields no clip.
 */
export function archiveClipAt(clockMs: number, leadMs = 0, segments: readonly ArchiveSegment[] | null = null): ArchiveClipWindow | null {
  const targetMs = Math.floor((clockMs + Math.min(MAX_CLIP_LEAD_MS, Math.max(0, leadMs))) / 1_000) * 1_000;
  if (!segments) return clipWindow(targetMs, ARCHIVE_CLIP_MS);
  const segment = segments.find((s) => targetMs < s.endMs && targetMs + 1_000 > s.startMs);
  if (!segment) return null;
  const startMs = Math.max(targetMs, Math.ceil((segment.startMs + SEGMENT_START_MARGIN_MS) / 1_000) * 1_000);
  const lengthMs = Math.min(ARCHIVE_CLIP_MS, Math.floor((segment.endMs - startMs) / 1_000) * 1_000);
  return lengthMs >= MIN_CLIP_MS ? clipWindow(startMs, lengthMs) : null;
}

function clipWindow(startMs: number, lengthMs: number): ArchiveClipWindow {
  return {
    startMs,
    endMs: startMs + lengthMs,
    startIso: new Date(startMs).toISOString(),
    durationSeconds: lengthMs / 1_000,
  };
}

/**
 * Keep the current clip while the clock plays through it; start a new clip when
 * the clock leaves it or jumps (a seek), or when nothing is loaded yet. `null`
 * means the clock is in a recording gap; it is re-resolved on every sample.
 */
export function resolveArchiveClip(
  current: ArchiveClipWindow | null,
  previousClockMs: number,
  clockMs: number,
  speed: number,
  leadMs = 0,
  segments: readonly ArchiveSegment[] | null = null,
): ArchiveClipWindow | null {
  if (!current || clockMs < current.startMs - MAX_CLIP_LEAD_MS || clockMs >= current.endMs) {
    return archiveClipAt(clockMs, leadMs, segments);
  }
  if (Number.isFinite(previousClockMs)) {
    const expectedAdvanceMs = Math.max(0, speed) * 1_000;
    if (Math.abs(clockMs - previousClockMs) > CLIP_SEEK_JUMP_MS + expectedAdvanceMs) return archiveClipAt(clockMs, leadMs, segments);
  }
  return current;
}

/**
 * Recorded segments from a MediaMTX `/list` body (`[{start, duration}]`),
 * shifted from archive time into replay-clock time by `archiveOffsetSeconds`.
 */
export function parseArchiveSegments(body: unknown, archiveOffsetSeconds = 0): ArchiveSegment[] | null {
  if (!Array.isArray(body)) return null;
  const offsetMs = archiveOffsetSeconds * 1_000;
  const segments: ArchiveSegment[] = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') return null;
    const { start, duration } = item as { start?: unknown; duration?: unknown };
    const startMs = typeof start === 'string' ? Date.parse(start) : Number.NaN;
    if (!Number.isFinite(startMs) || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
    segments.push({ startMs: startMs - offsetMs, endMs: startMs - offsetMs + duration * 1_000 });
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}

export function archiveListUrl(template: string, channel: string, startMs: number, endMs: number, archiveOffsetSeconds = 0): string {
  const offsetMs = archiveOffsetSeconds * 1_000;
  return template
    .replaceAll('{channel}', encodeURIComponent(channel))
    .replaceAll('{start}', encodeURIComponent(new Date(startMs + offsetMs).toISOString()))
    .replaceAll('{end}', encodeURIComponent(new Date(endMs + offsetMs).toISOString()));
}

/**
 * Start-up lag of a playing clip: how far the clock has moved past the clip
 * start while the video is still near its beginning. Only meaningful while the
 * video cannot seek (progressive MP4); a seekable video is corrected directly.
 */
export function clipStartupLagSeconds(clip: ArchiveClipWindow, clockMs: number, currentTime: number): number {
  return Math.max(0, (clockMs - clip.startMs) / 1_000 - currentTime);
}

export function archiveVideoUrl(
  template: string,
  channel: string,
  clip: ArchiveClipWindow,
  archiveOffsetSeconds = 0,
): string {
  const archiveStartIso = new Date(clip.startMs + archiveOffsetSeconds * 1_000).toISOString();
  return template
    .replaceAll('{channel}', encodeURIComponent(channel))
    .replaceAll('{start}', encodeURIComponent(archiveStartIso))
    .replaceAll('{duration}', String(clip.durationSeconds));
}

export function shouldCorrectVideoDrift(currentTime: number, targetTime: number): boolean {
  return !Number.isFinite(currentTime)
    || !Number.isFinite(targetTime)
    || Math.abs(currentTime - targetTime) > VIDEO_DRIFT_LIMIT_SECONDS;
}

export function coverageTrackBackground(
  buckets: readonly DetectionCoverageBucket[],
  startMs: number,
  endMs: number,
): string {
  const duration = endMs - startMs;
  if (duration <= 0 || buckets.length === 0) return 'hsl(var(--muted))';
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.detections));
  const stops = buckets.flatMap((bucket) => {
    const bucketStart = Date.parse(bucket.start);
    if (!Number.isFinite(bucketStart)) return [];
    const left = Math.max(0, Math.min(100, (bucketStart - startMs) / duration * 100));
    const right = Math.max(left, Math.min(100, (bucketStart + ARCHIVE_CLIP_MS - startMs) / duration * 100));
    const strength = bucket.detections === 0 ? 0 : 0.25 + 0.75 * bucket.detections / peak;
    const color = strength === 0 ? 'hsl(var(--muted))' : `hsl(var(--primary) / ${strength.toFixed(3)})`;
    return [`${color} ${left.toFixed(3)}%`, `${color} ${right.toFixed(3)}%`];
  });
  return stops.length === 0 ? 'hsl(var(--muted))' : `linear-gradient(to right, ${stops.join(', ')})`;
}

export function latestActivityMs(buckets: readonly DetectionCoverageBucket[]): number | null {
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    const bucket = buckets[index]!;
    const startMs = Date.parse(bucket.start);
    if (bucket.detections > 0 && Number.isFinite(startMs)) return startMs;
  }
  return null;
}

export function toLocalDateTimeInput(epochMs: number): string {
  const date = new Date(epochMs);
  const localMs = epochMs - date.getTimezoneOffset() * 60_000;
  return new Date(localMs).toISOString().slice(0, 16);
}

export function localDateTimeInputToIso(value: string): string | null {
  const epochMs = new Date(value).getTime();
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}
