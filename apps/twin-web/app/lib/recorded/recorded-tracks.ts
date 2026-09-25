import type { ActorKind, SimScenarioInputSpec } from "@simforge-oss/engine";
import { LegacyFlatEarthFrame } from "@simforge-oss/maps/opendrive";

export interface HistoryDetection {
  ts: string;
  camera: string;
  object_id: string;
  object_type: string;
  confidence: number;
  lat: number;
  lon: number;
}

/** A smoothed scene-frame sample; `t` is seconds from the window start. */
export interface RecordedPoint {
  t: number;
  x: number;
  z: number;
}

export interface RecordedTrack {
  id: string;
  objectType: string;
  kind: ActorKind;
  cameras: readonly string[];
  points: readonly RecordedPoint[];
}

export type RecordedActorInput = SimScenarioInputSpec["actors"][number];
export type RecordedInteractionInput = NonNullable<SimScenarioInputSpec["interactions"]>[number];

export const RECORDED_ACTOR_TAG = "recorded";

export const HISTORY_PAGE_LIMIT = 5_000;
export const RECORDED_SAMPLE_HZ = 5;
export const MIN_TRACK_DETECTIONS = 5;
export const MIN_TRACK_SPAN_S = 1;
export const MERGE_MIN_OVERLAP_S = 2;
export const MERGE_MAX_MEAN_DISTANCE_M = 2.5;

const PRESENT_AT_START_S = 0.05;
const EARLY_EXIT_MARGIN_S = 0.5;
const HEADING_MIN_DISPLACEMENT_M = 0.3;
const ACTOR_ID_INVALID = /[^A-Za-z0-9._:@/-]/g;
// Recorded-vs-recorded contact crash-disables replay: 0.3 m peds, ≥0.45 m (0.3·√2) separation, and exit at the last sample (engine release motion collided) → zero contacts on the fixture.
const RECORDED_PEDESTRIAN_DIMS = { l: 0.3, w: 0.3, h: 1.75 };
const MIN_PEDESTRIAN_SEPARATION_M = 0.45;

const KIND_BY_OBJECT_TYPE: Readonly<Record<string, ActorKind>> = {
  car: "car",
  truck: "truck",
  bus: "bus",
  van: "van",
  motorcycle: "motorcycle",
  bicycle: "bicycle",
  person: "pedestrian",
  pedestrian: "pedestrian",
};

/**
 * Constant-velocity RTS smoother noise: `accelPsd` is the white-acceleration
 * spectral density (m²/s³), `measurementSigmaM` the per-detection position
 * noise. Pedestrians move gently but carry metre-scale monocular jitter.
 */
interface SmootherParams {
  accelPsd: number;
  measurementSigmaM: number;
  initialSpeedSigmaMps: number;
}
const PEDESTRIAN_SMOOTHER: SmootherParams = { accelPsd: 0.3, measurementSigmaM: 1.2, initialSpeedSigmaMps: 3 };
const VEHICLE_SMOOTHER: SmootherParams = { accelPsd: 3, measurementSigmaM: 1.5, initialSpeedSigmaMps: 20 };

function detectionKey(d: HistoryDetection): string {
  return `${Date.parse(d.ts)}|${d.camera}|${d.object_id}`;
}

/** Pages `/detections/history` over [startMs, endMs] following `next`, deduping page-boundary repeats. */
export async function fetchWindowDetections(
  historyUrl: string,
  startMs: number,
  endMs: number,
  opts: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<HistoryDetection[]> {
  const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
  const endIso = new Date(endMs).toISOString();
  const separator = historyUrl.includes("?") ? "&" : "?";
  const seen = new Set<string>();
  const out: HistoryDetection[] = [];
  let cursor = new Date(startMs).toISOString();
  for (;;) {
    const params = new URLSearchParams({ start: cursor, end: endIso, limit: String(HISTORY_PAGE_LIMIT) });
    const response = await fetcher(`${historyUrl}${separator}${params}`, { signal: opts.signal });
    if (!response.ok) throw new Error(`Detection history request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { items?: HistoryDetection[]; next?: string | null };
    for (const item of body.items ?? []) {
      const key = detectionKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    const next = body.next ?? null;
    if (next === null) return out;
    if (!(Date.parse(next) > Date.parse(cursor))) throw new Error(`Detection history cursor did not advance past ${cursor}`);
    cursor = next;
  }
}

/** WGS-84 → scene ground point through the map's legacy flat-earth frame. */
export function sceneFrameFromProj(proj: string): (lat: number, lon: number) => { x: number; z: number } {
  const frame = LegacyFlatEarthFrame.fromProjString(proj);
  return (lat, lon) => {
    const fe = frame.wgs84ToLocal(lat, lon);
    return { x: fe.x, z: fe.y };
  };
}

interface Observation {
  t: number;
  x: number;
  z: number;
}

interface Member {
  objectId: string;
  objectType: string;
  camera: string;
  kind: ActorKind;
  observations: Observation[];
  startT: number;
  endT: number;
}

interface Cluster {
  key: number;
  kind: ActorKind;
  members: Member[];
  /** Grid index of `points[0]`; sample i sits at `(gridStart + i) / RECORDED_SAMPLE_HZ`. */
  gridStart: number;
  points: RecordedPoint[];
}

function compareMembers(a: Member, b: Member): number {
  return a.startT - b.startT || (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0);
}

/**
 * Two-sided constant-velocity Kalman (forward) + Rauch–Tung–Striebel
 * (backward) smoother, evaluated on the 5 Hz grid inside the observed span.
 * Both axes share one covariance because they share timing and noise.
 */
function smoothOnGrid(observations: readonly Observation[], params: SmootherParams): { gridStart: number; points: RecordedPoint[] } {
  const first = observations[0]!.t;
  const last = observations[observations.length - 1]!.t;
  const gridStart = Math.ceil(first * RECORDED_SAMPLE_HZ - 1e-9);
  const gridEnd = Math.floor(last * RECORDED_SAMPLE_HZ + 1e-9);
  const events: { t: number; obs: Observation | null }[] = [];
  let oi = 0;
  for (let k = gridStart; k <= gridEnd; k++) {
    const t = k / RECORDED_SAMPLE_HZ;
    while (oi < observations.length && observations[oi]!.t <= t + 1e-9) events.push({ t: observations[oi]!.t, obs: observations[oi++]! });
    events.push({ t, obs: null });
  }
  while (oi < observations.length) events.push({ t: observations[oi]!.t, obs: observations[oi++]! });
  const r = params.measurementSigmaM ** 2;
  const q = params.accelPsd;
  const n = events.length;
  // Filtered and predicted moments; covariance stored as [p00, p01, p11].
  const fx = new Float64Array(n * 2);
  const fz = new Float64Array(n * 2);
  const fp = new Float64Array(n * 3);
  const px = new Float64Array(n * 2);
  const pz = new Float64Array(n * 2);
  const pp = new Float64Array(n * 3);
  const dts = new Float64Array(n);
  const o0 = events[0]!.obs!;
  let mx0 = o0.x, mx1 = 0, mz0 = o0.z, mz1 = 0;
  let p00 = r, p01 = 0, p11 = params.initialSpeedSigmaMps ** 2;
  for (let i = 0; i < n; i++) {
    const event = events[i]!;
    if (i > 0) {
      const dt = Math.max(0, event.t - events[i - 1]!.t);
      dts[i] = dt;
      mx0 += dt * mx1;
      mz0 += dt * mz1;
      const n00 = p00 + 2 * dt * p01 + dt * dt * p11 + (q * dt ** 3) / 3;
      const n01 = p01 + dt * p11 + (q * dt * dt) / 2;
      const n11 = p11 + q * dt;
      p00 = n00; p01 = n01; p11 = n11;
    }
    px[i * 2] = mx0; px[i * 2 + 1] = mx1;
    pz[i * 2] = mz0; pz[i * 2 + 1] = mz1;
    pp[i * 3] = p00; pp[i * 3 + 1] = p01; pp[i * 3 + 2] = p11;
    if (event.obs && i > 0) {
      const s = p00 + r;
      const k0 = p00 / s;
      const k1 = p01 / s;
      const ix = event.obs.x - mx0;
      const iz = event.obs.z - mz0;
      mx0 += k0 * ix; mx1 += k1 * ix;
      mz0 += k0 * iz; mz1 += k1 * iz;
      const u00 = (1 - k0) * p00;
      const u01 = (1 - k0) * p01;
      const u11 = p11 - k1 * p01;
      p00 = u00; p01 = u01; p11 = u11;
    }
    fx[i * 2] = mx0; fx[i * 2 + 1] = mx1;
    fz[i * 2] = mz0; fz[i * 2 + 1] = mz1;
    fp[i * 3] = p00; fp[i * 3 + 1] = p01; fp[i * 3 + 2] = p11;
  }
  // Backward pass: C = P_k Fᵀ (P⁻_{k+1})⁻¹.
  let sx0 = fx[(n - 1) * 2]!, sx1 = fx[(n - 1) * 2 + 1]!;
  let sz0 = fz[(n - 1) * 2]!, sz1 = fz[(n - 1) * 2 + 1]!;
  const points: RecordedPoint[] = [];
  const pushIfGrid = (i: number) => {
    if (events[i]!.obs === null) points.push({ t: round3(events[i]!.t), x: round3(sx0), z: round3(sz0) });
  };
  pushIfGrid(n - 1);
  for (let i = n - 2; i >= 0; i--) {
    const dt = dts[i + 1]!;
    const a00 = fp[i * 3]!, a01 = fp[i * 3 + 1]!, a11 = fp[i * 3 + 2]!;
    // P_k Fᵀ with F = [[1, dt], [0, 1]].
    const b00 = a00 + dt * a01, b01 = a01;
    const b10 = a01 + dt * a11, b11 = a11;
    const c00 = pp[(i + 1) * 3]!, c01 = pp[(i + 1) * 3 + 1]!, c11 = pp[(i + 1) * 3 + 2]!;
    const det = c00 * c11 - c01 * c01;
    const i00 = c11 / det, i01 = -c01 / det, i11 = c00 / det;
    const g00 = b00 * i00 + b01 * i01, g01 = b00 * i01 + b01 * i11;
    const g10 = b10 * i00 + b11 * i01, g11 = b10 * i01 + b11 * i11;
    const dx0 = sx0 - px[(i + 1) * 2]!, dx1 = sx1 - px[(i + 1) * 2 + 1]!;
    const dz0 = sz0 - pz[(i + 1) * 2]!, dz1 = sz1 - pz[(i + 1) * 2 + 1]!;
    sx0 = fx[i * 2]! + g00 * dx0 + g01 * dx1;
    sx1 = fx[i * 2 + 1]! + g10 * dx0 + g11 * dx1;
    sz0 = fz[i * 2]! + g00 * dz0 + g01 * dz1;
    sz1 = fz[i * 2 + 1]! + g10 * dz0 + g11 * dz1;
    pushIfGrid(i);
  }
  points.reverse();
  return { gridStart, points };
}

function round3(v: number): number {
  return Math.round(v * 1_000) / 1_000;
}

function makeCluster(key: number, members: Member[]): Cluster {
  const ordered = [...members].sort(compareMembers);
  const kind = ordered[0]!.kind;
  const observations = ordered.flatMap((m) => m.observations).sort((a, b) => a.t - b.t);
  const { gridStart, points } = smoothOnGrid(observations, kind === "pedestrian" ? PEDESTRIAN_SMOOTHER : VEHICLE_SMOOTHER);
  return { key, kind, members: ordered, gridStart, points };
}

/** One camera seeing both clusters at the same time means two distinct objects. */
function camerasConflict(a: Cluster, b: Cluster): boolean {
  for (const ma of a.members) {
    for (const mb of b.members) {
      if (ma.camera === mb.camera && ma.startT <= mb.endT && mb.startT <= ma.endT) return true;
    }
  }
  return false;
}

/** Mean distance over the shared grid span, or null when not a merge candidate. */
function mergeDistance(a: Cluster, b: Cluster): number | null {
  if (a.kind !== b.kind) return null;
  const lo = Math.max(a.gridStart, b.gridStart);
  const hi = Math.min(a.gridStart + a.points.length - 1, b.gridStart + b.points.length - 1);
  if ((hi - lo) / RECORDED_SAMPLE_HZ < MERGE_MIN_OVERLAP_S - 1e-9) return null;
  if (camerasConflict(a, b)) return null;
  let sum = 0;
  for (let k = lo; k <= hi; k++) {
    const pa = a.points[k - a.gridStart]!;
    const pb = b.points[k - b.gridStart]!;
    sum += Math.hypot(pa.x - pb.x, pa.z - pb.z);
  }
  const mean = sum / (hi - lo + 1);
  return mean <= MERGE_MAX_MEAN_DISTANCE_M ? mean : null;
}

/**
 * Recorded detections → smoothed 5 Hz scene tracks. Cross-camera duplicates
 * (same kind, ≥2 s overlap, ≤2.5 m mean separation, never two simultaneous
 * tracks from one camera) are merged greedily, closest pair first, and
 * re-smoothed from their combined observations.
 */
export function buildRecordedTracks(
  detections: readonly HistoryDetection[],
  opts: { windowStartMs: number; windowEndMs: number; toScene: (lat: number, lon: number) => { x: number; z: number } },
): RecordedTrack[] {
  const seen = new Set<string>();
  const byObject = new Map<string, Member>();
  for (const d of detections) {
    const ms = Date.parse(d.ts);
    if (!Number.isFinite(ms) || ms < opts.windowStartMs || ms > opts.windowEndMs) continue;
    const kind = KIND_BY_OBJECT_TYPE[d.object_type];
    if (!kind || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    const key = detectionKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    let member = byObject.get(d.object_id);
    if (!member) {
      member = { objectId: d.object_id, objectType: d.object_type, camera: d.camera, kind, observations: [], startT: 0, endT: 0 };
      byObject.set(d.object_id, member);
    }
    const p = opts.toScene(d.lat, d.lon);
    member.observations.push({ t: (ms - opts.windowStartMs) / 1_000, x: p.x, z: p.z });
  }

  const members: Member[] = [];
  for (const member of byObject.values()) {
    member.observations.sort((a, b) => a.t - b.t);
    member.startT = member.observations[0]!.t;
    member.endT = member.observations[member.observations.length - 1]!.t;
    if (member.observations.length < MIN_TRACK_DETECTIONS || member.endT - member.startT < MIN_TRACK_SPAN_S) continue;
    members.push(member);
  }
  members.sort(compareMembers);

  let nextKey = 0;
  const clusters = new Map<number, Cluster>();
  for (const member of members) {
    const cluster = makeCluster(nextKey++, [member]);
    clusters.set(cluster.key, cluster);
  }
  const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const candidates = new Map<string, { a: number; b: number; distance: number }>();
  const consider = (a: Cluster, b: Cluster) => {
    const distance = mergeDistance(a, b);
    if (distance !== null) candidates.set(pairKey(a.key, b.key), { a: Math.min(a.key, b.key), b: Math.max(a.key, b.key), distance });
  };
  const initial = [...clusters.values()];
  for (let i = 0; i < initial.length; i++) for (let j = i + 1; j < initial.length; j++) consider(initial[i]!, initial[j]!);

  for (;;) {
    let best: { a: number; b: number; distance: number } | null = null;
    for (const c of candidates.values()) {
      if (!best || c.distance < best.distance || (c.distance === best.distance && (c.a < best.a || (c.a === best.a && c.b < best.b)))) best = c;
    }
    if (!best) break;
    const a = clusters.get(best.a)!;
    const b = clusters.get(best.b)!;
    clusters.delete(a.key);
    clusters.delete(b.key);
    for (const [key, c] of candidates) if (c.a === a.key || c.b === a.key || c.a === b.key || c.b === b.key) candidates.delete(key);
    const merged = makeCluster(nextKey++, [...a.members, ...b.members]);
    for (const other of clusters.values()) consider(merged, other);
    clusters.set(merged.key, merged);
  }

  const tracks: RecordedTrack[] = [...clusters.values()].map((cluster) => {
    const lead = cluster.members[0]!;
    return {
      id: `rec:${lead.objectId.replace(ACTOR_ID_INVALID, "_")}`.slice(0, 128),
      objectType: lead.objectType,
      kind: cluster.kind,
      cameras: [...new Set(cluster.members.map((m) => m.camera))].sort(),
      points: cluster.points,
    };
  });
  const sorted = tracks
    .filter((track) => track.points.length >= 2)
    .sort((a, b) => a.points[0]!.t - b.points[0]!.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  separatePedestrians(sorted);
  return sorted;
}

/** Pushes simultaneous recorded pedestrians symmetrically apart until they are ≥ MIN_PEDESTRIAN_SEPARATION_M. */
function separatePedestrians(tracks: RecordedTrack[]): void {
  const byGrid = new Map<number, { x: number; z: number }[]>();
  for (const track of tracks) {
    if (track.kind !== "pedestrian") continue;
    for (const p of track.points as RecordedPoint[]) {
      const k = Math.round(p.t * RECORDED_SAMPLE_HZ);
      const slot = byGrid.get(k);
      if (slot) slot.push(p);
      else byGrid.set(k, [p]);
    }
  }
  for (const slot of byGrid.values()) {
    if (slot.length < 2) continue;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (let i = 0; i < slot.length; i++) {
        for (let j = i + 1; j < slot.length; j++) {
          const a = slot[i]!;
          const b = slot[j]!;
          const d = Math.hypot(b.x - a.x, b.z - a.z);
          if (d >= MIN_PEDESTRIAN_SEPARATION_M - 1e-6) continue;
          const ux = d > 1e-6 ? (b.x - a.x) / d : 1;
          const uz = d > 1e-6 ? (b.z - a.z) / d : 0;
          const push = (MIN_PEDESTRIAN_SEPARATION_M - d) / 2;
          a.x = round3(a.x - ux * push); a.z = round3(a.z - uz * push);
          b.x = round3(b.x + ux * push); b.z = round3(b.z + uz * push);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
}

/** Local-frame heading of scene motion from `a` to `b` (forward = (cos h, -sin h)). */
function headingBetween(a: RecordedPoint, b: RecordedPoint): number {
  return Math.atan2(-(b.z - a.z), b.x - a.x);
}

function initialHeading(points: readonly RecordedPoint[]): number {
  const p0 = points[0]!;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (Math.hypot(p.x - p0.x, p.z - p0.z) >= HEADING_MIN_DISPLACEMENT_M) return headingBetween(p0, p);
  }
  const last = points[points.length - 1]!;
  return Math.hypot(last.x - p0.x, last.z - p0.z) > 1e-6 ? headingBetween(p0, last) : 0;
}

/**
 * Recorded tracks → engine actors replaying their exact timed paths, plus
 * `exist` interactions for late entries and early exits.
 */
export function recordedScenarioParts(
  tracks: readonly RecordedTrack[],
  clipSeconds: number,
): { actors: RecordedActorInput[]; interactions: RecordedInteractionInput[] } {
  const actors: RecordedActorInput[] = [];
  const interactions: RecordedInteractionInput[] = [];
  for (const track of tracks) {
    const points = track.points
      .filter((p) => p.t >= -1e-6 && p.t <= clipSeconds + 1e-6)
      .map((p) => ({ t: Math.min(clipSeconds, Math.max(0, p.t)), x: p.x, z: p.z }));
    if (points.length < 2) continue;
    const first = points[0]!;
    const second = points[1]!;
    const last = points[points.length - 1]!;
    const segmentS = second.t - first.t;
    const speedMps = segmentS > 0 ? Math.hypot(second.x - first.x, second.z - first.z) / segmentS : 0;
    const presentAtStart = first.t <= PRESENT_AT_START_S;
    actors.push({
      id: track.id,
      kind: track.kind,
      ...(track.kind === "pedestrian" ? { dims: { ...RECORDED_PEDESTRIAN_DIMS } } : {}),
      initial: { pose: { x: first.x, z: first.z, headingRad: initialHeading(points) }, speedMps: round3(speedMps) },
      behavior: { route: { kind: "timedPolyline", points: points.map((p) => ({ timeS: p.t, x: p.x, z: p.z })) } },
      presentAtStart,
      tags: [RECORDED_ACTOR_TAG],
    });
    if (!presentAtStart) {
      interactions.push({ id: `${track.id}:enter`, actorId: track.id, trigger: { kind: "at", t: first.t }, verb: "exist", target: { state: "present" } });
    }
    if (last.t < clipSeconds - EARLY_EXIT_MARGIN_S) {
      interactions.push({
        id: `${track.id}:exit`,
        actorId: track.id,
        trigger: { kind: "at", t: last.t },
        verb: "exist",
        target: { state: "absent" },
      });
    }
  }
  return { actors, interactions };
}
