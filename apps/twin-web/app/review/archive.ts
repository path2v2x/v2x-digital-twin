import type { TimeRange } from "./camera-timeline";
import type { DetectionEvent } from "./detection-events";

/** How to reach archived footage; all instants in the UI are detection time, the archive runs `offsetSeconds` later. */
export interface ArchiveAccess {
  /** MediaMTX `/get` template with `{channel}`, `{start}` and `{duration}`; must request `format=fmp4`. */
  urlTemplate: string;
  /** MediaMTX `/list` template with `{channel}`, `{start}` and `{end}`. */
  listUrlTemplate: string | null;
  offsetSeconds: number;
}

/** Footage loaded from a timeline click when no event says otherwise. */
export const DEFAULT_WINDOW_MS = 30_000;
/** Longest single footage request. */
export const MAX_WINDOW_MS = 60_000;
/** Footage kept after a clicked event ends. */
export const EVENT_PADDING_MS = 5_000;
/** A clicked event plays from this long before its first detection. */
export const LEAD_IN_MS = 2_000;

const SECOND = 1_000;

/**
 * Window starting at the whole second of `ms`. Every byte before the first
 * shown frame delays it, so windows start where the picture is needed.
 */
export function windowAround(ms: number, lengthMs = DEFAULT_WINDOW_MS): TimeRange {
  const startMs = Math.floor(ms / SECOND) * SECOND;
  return { startMs, endMs: startMs + lengthMs };
}

/** A clicked event from `LEAD_IN_MS` before it to `EVENT_PADDING_MS` after, in whole seconds, at most `MAX_WINDOW_MS`. */
export function eventFootageWindow(event: DetectionEvent): TimeRange {
  const startMs = Math.floor((event.startMs - LEAD_IN_MS) / SECOND) * SECOND;
  const endMs = Math.ceil((event.endMs + EVENT_PADDING_MS) / SECOND) * SECOND;
  return { startMs, endMs: Math.min(endMs, startMs + MAX_WINDOW_MS) };
}

function archiveIso(ms: number, offsetSeconds: number): string {
  return encodeURIComponent(new Date(ms + offsetSeconds * SECOND).toISOString());
}

export function footageUrl(access: ArchiveAccess, channel: string, window: TimeRange): string {
  return access.urlTemplate
    .replaceAll("{channel}", encodeURIComponent(channel))
    .replaceAll("{start}", archiveIso(window.startMs, access.offsetSeconds))
    .replaceAll("{duration}", String(Math.max(1, Math.round((window.endMs - window.startMs) / SECOND))));
}

export function archiveListUrl(template: string, channel: string, startMs: number, endMs: number, offsetSeconds = 0): string {
  return template
    .replaceAll("{channel}", encodeURIComponent(channel))
    .replaceAll("{start}", archiveIso(startMs, offsetSeconds))
    .replaceAll("{end}", archiveIso(endMs, offsetSeconds));
}

/** Recorded spans from a MediaMTX `/list` body (`[{start, duration}]`), shifted from archive time into detection time. */
export function parseArchiveSegments(body: unknown, offsetSeconds = 0): TimeRange[] | null {
  if (!Array.isArray(body)) return null;
  const offsetMs = offsetSeconds * SECOND;
  const segments: TimeRange[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") return null;
    const { start, duration } = item as { start?: unknown; duration?: unknown };
    const startMs = typeof start === "string" ? Date.parse(start) : Number.NaN;
    if (!Number.isFinite(startMs) || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
    segments.push({ startMs: startMs - offsetMs, endMs: startMs - offsetMs + duration * SECOND });
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}

const AVCC = [0x61, 0x76, 0x63, 0x43];

/**
 * `avc1.PPCCLL` from the `avcC` box of an fMP4 init segment, or null until
 * enough bytes have arrived. MediaSource needs it before the first append.
 */
export function avcCodecFromInit(bytes: Uint8Array): string | null {
  for (let i = 0; i + 7 < bytes.length; i += 1) {
    if (bytes[i] !== AVCC[0] || bytes[i + 1] !== AVCC[1] || bytes[i + 2] !== AVCC[2] || bytes[i + 3] !== AVCC[3]) continue;
    // avcC payload: configurationVersion, AVCProfileIndication, profile_compatibility, AVCLevelIndication.
    const hex = (value: number) => value.toString(16).padStart(2, "0");
    return `avc1.${hex(bytes[i + 5]!)}${hex(bytes[i + 6]!)}${hex(bytes[i + 7]!)}`;
  }
  return null;
}
