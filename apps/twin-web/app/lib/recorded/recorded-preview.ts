import { DEFAULT_ACTOR_DIMS, type ActorKind } from "@simforge-oss/engine";
import type { ActorClass } from "@simforge-oss/engine/scene-state";
import type { TruthFrame } from "@simforge-oss/training-env/browser";

import { RECORDED_PEDESTRIAN_DIMS, type RecordedPoint, type RecordedTrack } from "./recorded-tracks";

/** A recorded track ready to be sampled at any instant without the engine. */
export interface PreviewTrack {
  readonly id: string;
  readonly actorClass: ActorClass;
  readonly dims: { l: number; w: number; h: number };
  readonly points: readonly RecordedPoint[];
  /** Heading at each point, held through stops. */
  readonly headings: readonly number[];
}

/** Displacement needed before a heading is trusted; below it the previous heading holds. */
const HEADING_MIN_DISPLACEMENT_M = 0.3;

const CLASS_BY_KIND: Partial<Record<ActorKind, ActorClass>> = {
  truck: "truck",
  bus: "bus",
  motorcycle: "motorcycle",
  scooter: "motorcycle",
  bicycle: "bicycle",
  pedestrian: "pedestrian",
};

export function preparePreviewTracks(tracks: readonly RecordedTrack[]): PreviewTrack[] {
  return tracks.filter((track) => track.points.length > 0).map((track) => ({
    id: track.id,
    actorClass: CLASS_BY_KIND[track.kind] ?? "car",
    dims: track.kind === "pedestrian" ? { ...RECORDED_PEDESTRIAN_DIMS } : { ...DEFAULT_ACTOR_DIMS[track.kind] },
    points: track.points,
    headings: pointHeadings(track.points),
  }));
}

/** The recorded actors at `tSec` (seconds from the window start); actors outside their recorded span are absent. */
export function recordedPreviewFrame(tracks: readonly PreviewTrack[], tSec: number, tick: number): TruthFrame {
  const scene: TruthFrame["scene"]["actors"][number][] = [];
  const actors: TruthFrame["actors"][number][] = [];
  for (const track of tracks) {
    const sample = sampleTrack(track, tSec);
    if (!sample) continue;
    scene.push({
      id: track.id,
      kind: "update",
      position: [sample.x, 0, sample.z],
      rotation: [0, Math.sin(sample.headingRad / 2), 0, Math.cos(sample.headingRad / 2)],
      yawRad: sample.headingRad,
      velocity: [sample.vx, 0, sample.vz],
      acceleration: [0, 0, 0],
    });
    actors.push({ id: track.id, class: track.actorClass, dims: track.dims, accel: { ax: 0, ay: 0 } });
  }
  return { tick, timeSec: tSec, scene: { tick, t: tSec, actors: scene }, signals: [], actors };
}

function sampleTrack(track: PreviewTrack, tSec: number): { x: number; z: number; vx: number; vz: number; headingRad: number } | null {
  const { points, headings } = track;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (tSec < first.t || tSec > last.t) return null;
  let index = 0;
  while (index < points.length - 2 && points[index + 1]!.t <= tSec) index += 1;
  const a = points[index]!;
  const b = points[Math.min(index + 1, points.length - 1)]!;
  const span = b.t - a.t;
  const alpha = span > 0 ? Math.min(1, Math.max(0, (tSec - a.t) / span)) : 0;
  return {
    x: a.x + (b.x - a.x) * alpha,
    z: a.z + (b.z - a.z) * alpha,
    vx: span > 0 ? (b.x - a.x) / span : 0,
    vz: span > 0 ? (b.z - a.z) / span : 0,
    headingRad: headings[index]!,
  };
}

/** Local-frame heading (scene forward is `(cos h, -sin h)`) toward the next point far enough away, else the last trusted one. */
function pointHeadings(points: readonly RecordedPoint[]): number[] {
  const headings = new Array<number>(points.length).fill(Number.NaN);
  for (let i = 0; i < points.length; i += 1) {
    const from = points[i]!;
    for (let j = i + 1; j < points.length; j += 1) {
      const to = points[j]!;
      if (Math.hypot(to.x - from.x, to.z - from.z) >= HEADING_MIN_DISPLACEMENT_M) {
        headings[i] = Math.atan2(-(to.z - from.z), to.x - from.x);
        break;
      }
    }
  }
  let held = headings.find((heading) => Number.isFinite(heading)) ?? 0;
  for (let i = 0; i < headings.length; i += 1) {
    if (Number.isFinite(headings[i])) held = headings[i]!;
    else headings[i] = held;
  }
  return headings;
}
