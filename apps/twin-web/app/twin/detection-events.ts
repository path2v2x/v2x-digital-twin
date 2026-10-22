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
 * The simulation window for a clicked event: the event itself from its first
 * detection, at most `maxMs` long. Events are at least 2 s (the server drops
 * shorter ones), the shortest window Simulate takes.
 */
export function eventWindow(event: DetectionEvent, maxMs: number): TimeRange {
  return { startMs: event.startMs, endMs: Math.min(event.endMs, event.startMs + maxMs) };
}

export function describeEvent(event: DetectionEvent): string {
  const style = EVENT_STYLE[event.kind];
  const count = event.objects === 1 ? `1 ${style.label.toLowerCase()}` : `${event.objects} ${style.plural.toLowerCase()}`;
  const cameras = event.cameras.map((camera) => camera.toUpperCase()).join(", ");
  return cameras ? `${count} · ${cameras}` : count;
}
