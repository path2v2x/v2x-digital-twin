export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface RulerTick {
  ms: number;
  label: string;
  /** Local-midnight tick, labelled with the date. */
  major: boolean;
}

/** Local-time offset from UTC at an instant; injectable so tests are timezone independent. */
export type UtcOffset = (ms: number) => number;

export const localUtcOffset: UtcOffset = (ms) => -new Date(ms).getTimezoneOffset() * 60_000;

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const MIN_VIEW_SPAN_MS = 20 * SECOND_MS;
export const MAX_VIEW_SPAN_MS = 12 * HOUR_MS;
export const MAX_COVERAGE_BUCKETS = 2_000;
/** Smallest on-screen width of one coverage bucket. */
export const MIN_BUCKET_PX = 2;
/** Smallest gap between two labelled ruler ticks. */
export const MIN_TICK_SPACING_PX = 72;

const TICK_STEPS_MS = [
  SECOND_MS, 2 * SECOND_MS, 5 * SECOND_MS, 10 * SECOND_MS, 15 * SECOND_MS, 30 * SECOND_MS,
  MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS,
  HOUR_MS, 2 * HOUR_MS,
];

const BUCKET_STEPS_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Keep `view` inside `bounds`, shifting it first and shrinking only if it cannot fit. */
export function clampView(view: TimeRange, bounds: TimeRange): TimeRange {
  const boundsSpan = Math.max(0, bounds.endMs - bounds.startMs);
  const span = Math.min(Math.max(0, view.endMs - view.startMs), boundsSpan);
  const startMs = clamp(view.startMs, bounds.startMs, bounds.endMs - span);
  return { startMs, endMs: startMs + span };
}

/** Scale the view span by `factor` keeping `anchorMs` at the same relative position. */
export function zoomAround(
  view: TimeRange,
  anchorMs: number,
  factor: number,
  bounds: TimeRange,
  minSpanMs = MIN_VIEW_SPAN_MS,
  maxSpanMs = MAX_VIEW_SPAN_MS,
): TimeRange {
  const span = view.endMs - view.startMs;
  if (span <= 0 || !Number.isFinite(factor) || factor <= 0) return clampView(view, bounds);
  const boundsSpan = Math.max(0, bounds.endMs - bounds.startMs);
  const nextSpan = Math.min(clamp(span * factor, minSpanMs, maxSpanMs), boundsSpan);
  const ratio = clamp((anchorMs - view.startMs) / span, 0, 1);
  const startMs = anchorMs - ratio * nextSpan;
  return clampView({ startMs, endMs: startMs + nextSpan }, bounds);
}

/** Shift the view by `deltaMs` (e.g. ±12 h page buttons, drag, horizontal wheel), stopping at the bounds. */
export function pan(view: TimeRange, deltaMs: number, bounds: TimeRange): TimeRange {
  return clampView({ startMs: view.startMs + deltaMs, endMs: view.endMs + deltaMs }, bounds);
}

/** The default view: the last `spanMs` before the right bound. */
export function fitLatest(bounds: TimeRange, spanMs = MAX_VIEW_SPAN_MS): TimeRange {
  return clampView({ startMs: bounds.endMs - spanMs, endMs: bounds.endMs }, bounds);
}

export function msToX(ms: number, view: TimeRange, widthPx: number): number {
  const span = view.endMs - view.startMs;
  return span > 0 ? (ms - view.startMs) / span * widthPx : 0;
}

export function xToMs(x: number, view: TimeRange, widthPx: number): number {
  return widthPx > 0 ? view.startMs + x / widthPx * (view.endMs - view.startMs) : view.startMs;
}

/**
 * Coverage bucket in whole seconds: the smallest nice step at least
 * MIN_BUCKET_PX wide, never producing more than MAX_COVERAGE_BUCKETS buckets
 * for the span even after aligning the window to bucket boundaries.
 */
export function chooseBucketSeconds(spanMs: number, widthPx: number): number {
  const spanSeconds = Math.max(0, spanMs) / SECOND_MS;
  const byWidth = widthPx > 0 ? MIN_BUCKET_PX * spanSeconds / widthPx : spanSeconds;
  const byCount = spanSeconds / (MAX_COVERAGE_BUCKETS - 1);
  const minimum = Math.max(1, byWidth, byCount);
  return BUCKET_STEPS_SECONDS.find((step) => step >= minimum) ?? Math.ceil(minimum);
}

/** The request window for `view`, widened outward to whole buckets. */
export function coverageWindow(view: TimeRange, bucketSeconds: number): TimeRange {
  const bucketMs = bucketSeconds * SECOND_MS;
  return {
    startMs: Math.floor(view.startMs / bucketMs) * bucketMs,
    endMs: Math.ceil(view.endMs / bucketMs) * bucketMs,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `HH:MM:SS` (or `HH:MM`) of an instant in the offset's local time. */
export function formatClock(ms: number, withSeconds = true, utcOffset: UtcOffset = localUtcOffset): string {
  const local = new Date(ms + utcOffset(ms));
  const hm = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  return withSeconds ? `${hm}:${pad2(local.getUTCSeconds())}` : hm;
}

/** `Sep 24` of an instant in the offset's local time. */
export function formatDate(ms: number, utcOffset: UtcOffset = localUtcOffset): string {
  const local = new Date(ms + utcOffset(ms));
  return `${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / SECOND_MS;
  const rounded = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} s`;
}

/** `hh:mm:ss–hh:mm:ss · 42 s` */
export function formatSelection(selection: TimeRange, utcOffset: UtcOffset = localUtcOffset): string {
  return `${formatClock(selection.startMs, true, utcOffset)}–${formatClock(selection.endMs, true, utcOffset)} · ${formatDuration(selection.endMs - selection.startMs)}`;
}

/** `Sep 24 11:08 – Sep 24 23:08`, with seconds once the view is shorter than 10 minutes. */
export function formatViewRange(view: TimeRange, utcOffset: UtcOffset = localUtcOffset): string {
  const withSeconds = view.endMs - view.startMs < 10 * MINUTE_MS;
  const side = (ms: number) => `${formatDate(ms, utcOffset)} ${formatClock(ms, withSeconds, utcOffset)}`;
  return `${side(view.startMs)} – ${side(view.endMs)}`;
}

/**
 * Labelled ticks at the smallest nice step (1 s … 2 h) that keeps labels
 * MIN_TICK_SPACING_PX apart, aligned to local time. Local midnights are major
 * and labelled with the date.
 */
export function rulerTicks(view: TimeRange, widthPx: number, utcOffset: UtcOffset = localUtcOffset): RulerTick[] {
  const span = view.endMs - view.startMs;
  if (span <= 0 || widthPx <= 0) return [];
  const minStepMs = MIN_TICK_SPACING_PX * span / widthPx;
  const stepMs = TICK_STEPS_MS.find((step) => step >= minStepMs) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
  const offsetMs = utcOffset(view.startMs);
  const withSeconds = stepMs < MINUTE_MS;
  const ticks: RulerTick[] = [];
  for (let local = Math.ceil((view.startMs + offsetMs) / stepMs) * stepMs; local - offsetMs <= view.endMs; local += stepMs) {
    const ms = local - offsetMs;
    const major = local % DAY_MS === 0;
    ticks.push({ ms, major, label: major ? formatDate(ms, () => offsetMs) : formatClock(ms, withSeconds, () => offsetMs) });
  }
  return ticks;
}

/**
 * Selection from a fixed `anchorMs` toward `pointerMs`: the free end follows the
 * pointer but stays within `maxMs` of the anchor and inside `bounds`.
 */
export function clampSelection(anchorMs: number, pointerMs: number, maxMs: number, bounds: TimeRange): TimeRange {
  const anchor = clamp(anchorMs, bounds.startMs, bounds.endMs);
  const pointer = clamp(pointerMs, bounds.startMs, bounds.endMs);
  return pointer >= anchor
    ? { startMs: anchor, endMs: Math.min(pointer, anchor + maxMs) }
    : { startMs: Math.max(pointer, anchor - maxMs), endMs: anchor };
}

/** Move a whole selection by `deltaMs` without leaving `bounds`. */
export function moveSelection(selection: TimeRange, deltaMs: number, bounds: TimeRange): TimeRange {
  return clampView({ startMs: selection.startMs + deltaMs, endMs: selection.endMs + deltaMs }, bounds);
}

/** Parts of `view` not covered by any (sorted or unsorted) `segments`. */
export function uncoveredRanges(view: TimeRange, segments: readonly TimeRange[]): TimeRange[] {
  const gaps: TimeRange[] = [];
  let cursor = view.startMs;
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (segment.endMs <= cursor) continue;
    if (segment.startMs >= view.endMs) break;
    if (segment.startMs > cursor) gaps.push({ startMs: cursor, endMs: segment.startMs });
    cursor = Math.max(cursor, segment.endMs);
    if (cursor >= view.endMs) break;
  }
  if (cursor < view.endMs) gaps.push({ startMs: cursor, endMs: view.endMs });
  return gaps;
}

/** Heat-strip opacity for a bucket: log scale against the peak; zero stays transparent. */
export function densityAlpha(detections: number, peak: number): number {
  if (detections <= 0 || peak <= 0) return 0;
  return 0.15 + 0.85 * Math.min(1, Math.log1p(detections) / Math.log1p(peak));
}
