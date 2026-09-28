import type { TimeRange } from "./camera-timeline";

export type EventKind = "pedestrian" | "cyclist" | "vehicle" | "large_vehicle";

/** One `/detections/events` entry: same-kind moving objects, merged across cameras. */
export interface DetectionEvent {
  readonly id: string;
  readonly kind: EventKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly objects: number;
  readonly detections: number;
  /** Cameras by detections, most first. */
  readonly cameras: readonly string[];
}

export const EVENT_KINDS: readonly EventKind[] = ["pedestrian", "cyclist", "vehicle", "large_vehicle"];

export const EVENT_STYLE: Readonly<Record<EventKind, { label: string; plural: string; color: string }>> = {
  pedestrian: { label: "Pedestrian", plural: "Pedestrians", color: "#22d3ee" },
  cyclist: { label: "Cyclist", plural: "Cyclists", color: "#a3e635" },
  vehicle: { label: "Car", plural: "Cars", color: "#fb923c" },
  large_vehicle: { label: "Truck / bus", plural: "Trucks / buses", color: "#c084fc" },
};

/** Footage kept on each side of an event when it becomes the simulation window. */
export const EVENT_PADDING_MS = 2_000;

export function parseDetectionEvents(body: unknown): DetectionEvent[] {
  const items = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(items)) throw new Error("Malformed events response");
  return items.flatMap((item): DetectionEvent[] => {
    const value = item as Record<string, unknown>;
    const startMs = typeof value.start === "string" ? Date.parse(value.start) : Number.NaN;
    const endMs = typeof value.end === "string" ? Date.parse(value.end) : Number.NaN;
    const kind = value.kind as EventKind;
    if (typeof value.id !== "string" || !EVENT_KINDS.includes(kind) || !Number.isFinite(startMs) || !(endMs >= startMs)) return [];
    const cameras = Array.isArray(value.cameras)
      ? value.cameras.flatMap((entry) => (typeof (entry as { camera?: unknown })?.camera === "string" ? [(entry as { camera: string }).camera] : []))
      : [];
    return [{
      id: value.id,
      kind,
      startMs,
      endMs,
      objects: typeof value.objects === "number" ? value.objects : 1,
      detections: typeof value.detections === "number" ? value.detections : 0,
      cameras,
    }];
  });
}

/**
 * Lane per event so overlapping events stay visible: greedy first-fit in start
 * order, where events closer than `minGapMs` count as overlapping.
 */
export function packEventLanes(events: readonly DetectionEvent[], minGapMs: number): Map<string, number> {
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const event of [...events].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    let lane = laneEnds.findIndex((endMs) => event.startMs > endMs + minGapMs);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = Math.max(event.endMs, laneEnds[lane] ?? Number.NEGATIVE_INFINITY);
    lanes.set(event.id, lane);
  }
  return lanes;
}

/**
 * The simulation window for a clicked event: the whole event plus padding when
 * it fits in `maxMs`, otherwise `maxMs` centred on the click and kept inside the
 * padded event. Always inside `bounds`.
 */
export function eventWindow(event: DetectionEvent, clickMs: number, maxMs: number, bounds: TimeRange): TimeRange {
  const paddedStart = event.startMs - EVENT_PADDING_MS;
  const paddedEnd = event.endMs + EVENT_PADDING_MS;
  let startMs = paddedStart;
  let endMs = paddedEnd;
  if (endMs - startMs > maxMs) {
    startMs = Math.min(Math.max(clickMs - maxMs / 2, paddedStart), paddedEnd - maxMs);
    endMs = startMs + maxMs;
  }
  const shift = Math.max(0, bounds.startMs - startMs) - Math.max(0, endMs - bounds.endMs);
  return { startMs: Math.max(bounds.startMs, startMs + shift), endMs: Math.min(bounds.endMs, endMs + shift) };
}

export function describeEvent(event: DetectionEvent): string {
  const style = EVENT_STYLE[event.kind];
  const count = event.objects === 1 ? `1 ${style.label.toLowerCase()}` : `${event.objects} ${style.plural.toLowerCase()}`;
  const cameras = event.cameras.map((camera) => camera.toUpperCase()).join(", ");
  return cameras ? `${count} · ${cameras}` : count;
}
