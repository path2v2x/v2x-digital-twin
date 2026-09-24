/**
 * TwinSync port — detection mirroring as physics-light ghost actors.
 *
 * Semantics ported from apps/bridge/digital_twin_bridge/twin_sync.py:
 *  - accepted object types: car | truck | bus | person (person → pedestrian);
 *  - a track upserts on every detection record {object_id, object_type,
 *    gps_location{lat, lon}, confidence};
 *  - spawn at the flat-earth point (vehicle types adopt lane height/yaw when
 *    the detection lies within 4 m of a lane, like the v1 waypoint snap);
 *  - motion: chase the latest fix with the engine's dynamic body via
 *    zero-order-hold act overrides (v1 lerped transforms). Speed is
 *    proportional to the remaining gap and capped per type; inside the stop
 *    radius, or when a vehicle's fix is behind it or inside its turning
 *    circle, the actor holds its heading instead of circling the point;
 *    gaps beyond SNAP_M respawn the actor at the fix;
 *  - despawn after `despawnAfter` (12 s) without a sighting;
 *  - spawn rejections (footprint overlap) retry on the next poll, mirroring
 *    the v1 bounded-bootstrap retry.
 *
 * Modes, like v1: live (pollers feed `ingest`) or replay (recorded
 * detections walked by the replay clock; `use_detection_ts` semantics — a
 * track's last_seen is its record timestamp, and expiry is evaluated against
 * the virtual clock).
 */
import type { ActorKind } from '@simforge-oss/engine';
import { sceneFromWgs84, wgs84FromScene, legacyYawDegFromSceneHeading, type SceneXZ } from './geo.js';
import type { TwinWorld } from './world.js';

export interface DetectionRecord {
  readonly object_id: string;
  readonly object_type?: string;
  readonly gps_location?: { readonly lat?: number; readonly lon?: number };
  readonly confidence?: number;
  readonly confidence_score?: number;
  readonly timestamp_utc?: string;
  readonly event_id?: string;
  readonly media_timestamp_utc?: string;
  readonly timestamp_schema_version?: number | string;
  readonly media_time_trusted?: boolean;
  readonly media_clock?: unknown;
  readonly device_id?: string;
  readonly track_id?: string;
  readonly bbox?: unknown;
  readonly street_name?: string;
}

const VEHICLE_TYPES: Record<string, true> = { car: true, truck: true, bus: true };

interface ChaseProfile {
  readonly maxSpeedMps: number;
  /** Stop radius; the actor resumes once the fix is twice this far away. */
  readonly settleM: number;
  /** Forward-only turning radius; 0 for actors that can pivot in place. */
  readonly turnRadiusM: number;
}
const PERSON_CHASE: ChaseProfile = { maxSpeedMps: 3, settleM: 0.5, turnRadiusM: 0 };
const VEHICLE_CHASE: ChaseProfile = { maxSpeedMps: 20, settleM: 1.5, turnRadiusM: 5 };
/** Chase speed closes the remaining gap in about this long. */
const RESPONSE_S = 1;
/** Beyond this gap the actor is respawned at the fix rather than driven there. */
const SNAP_M = 15;

const KIND_BY_TYPE: Record<string, ActorKind> = {
  car: 'car',
  truck: 'truck',
  bus: 'bus',
  person: 'pedestrian',
};

export interface GhostTrack {
  readonly objectId: string;
  objectType: string;
  actorId: string | null;
  lastSeen: number;
  /** Last raw fix; repeated polls of the same summary are not new evidence. */
  fix: { lat: number; lon: number } | null;
  /** Scene-space target (the latest fix). */
  target: SceneXZ;
  /** Scene heading used when (re)spawning. */
  headingRad: number;
  holding: boolean;
  record: DetectionRecord;
}

export function parseUtcEpoch(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const text = value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
  const epoch = Date.parse(text);
  return Number.isFinite(epoch) ? epoch / 1000 : null;
}

export class GhostMirror {
  private readonly world: TwinWorld;
  readonly tracks = new Map<string, GhostTrack>();
  private readonly despawnAfterS: number;
  private lastActUpdate = 0;
  private paused = false;

  constructor(world: TwinWorld, despawnAfterS: number) {
    this.world = world;
    this.despawnAfterS = despawnAfterS;
  }

  /**
   * Upsert tracks from one batch of detection records.
   * `now` is wall time in live mode or the replay clock during replay;
   * `useDetectionTs` makes each track's last_seen its record timestamp.
   */
  ingest(records: readonly DetectionRecord[], now: number, opts: { useDetectionTs?: boolean } = {}): void {
    for (const det of records) {
      const objectId = det.object_id;
      const objectType = det.object_type ?? 'car';
      const lat = det.gps_location?.lat;
      const lon = det.gps_location?.lon;
      if (!objectId || lat === undefined || lon === undefined) continue;
      if (!VEHICLE_TYPES[objectType] && objectType !== 'person') continue;

      let track = this.tracks.get(objectId);
      if (!track) {
        track = {
          objectId,
          objectType,
          actorId: null,
          lastSeen: 0,
          fix: null,
          target: { x: 0, z: 0 },
          headingRad: 0,
          holding: false,
          record: det,
        };
        this.tracks.set(objectId, track);
      }
      track.record = det;
      track.objectType = objectType;
      if (opts.useDetectionTs) {
        track.lastSeen = parseUtcEpoch(det.timestamp_utc) ?? now;
      } else {
        track.lastSeen = now;
      }

      if (!track.fix || track.fix.lat !== lat || track.fix.lon !== lon) {
        track.fix = { lat, lon };
        track.target = this.placementFor(track, lat, lon);
      }
      if (!track.actorId) this.trySpawn(track);
    }
    this.expire(now);
  }

  /** v1 `_location_for`: vehicles adopt the lane yaw when within 4 m of one. */
  private placementFor(track: GhostTrack, lat: number, lon: number): SceneXZ {
    const scene = sceneFromWgs84(this.world.frame, lat, lon);
    if (VEHICLE_TYPES[track.objectType]) {
      const nearest = this.world.bundle.graph.nearestLane({ x: scene.x, y: -scene.z }, { maxDistM: 4 });
      if (nearest) {
        const reversed = this.world.bundle.graph.nominalReversed(nearest.rsl) ?? false;
        const geom = this.world.bundle.graph.geometry(nearest.rsl);
        if (geom) {
          const directedS = reversed ? geom.lengthM - nearest.s : nearest.s;
          const sample = this.world.bundle.graph.sampleDirected({ rsl: nearest.rsl, reversed }, directedS);
          track.headingRad = -sample.headingRad;
        }
      }
    }
    return scene;
  }

  private trySpawn(track: GhostTrack): void {
    const kind = KIND_BY_TYPE[track.objectType] ?? 'car';
    const pose = { x: track.target.x, z: track.target.z, headingRad: track.headingRad };
    const common = {
      category: 'ghost' as const,
      kind,
      blueprint: `twin.${track.objectType}`,
      meta: { name: track.objectId },
    };
    const result = this.paused
      ? this.world.spawn({
          ...common,
          spawn: {
            kind,
            pose,
            speedMps: 0,
            snapToLane: false,
            static: true,
            route: { kind: 'polyline' as const, points: [{ x: pose.x, z: pose.z }] },
          },
        })
      : this.world.spawnFreeform({ ...common, pose });
    if (result.ok) track.actorId = result.id;
    // Rejections (footprint overlap) retry on the next poll, as in v1.
  }

  /** Per-tick driver: chase the current target unless replay is paused. */
  drive(): void {
    if (this.paused) return;
    const wallNow = Date.now() / 1000;
    if (wallNow - this.lastActUpdate < 0.2) return;
    this.lastActUpdate = wallNow;
    for (const track of this.tracks.values()) {
      if (!track.actorId) continue;
      const state = this.world.actorState(track.actorId);
      if (!state) {
        track.actorId = null;
        continue;
      }
      const dx = track.target.x - state.x;
      const dz = track.target.z - state.z;
      const remaining = Math.hypot(dx, dz);
      if (remaining > SNAP_M) {
        this.world.despawn(track.actorId);
        track.actorId = null;
        track.headingRad = Math.atan2(dz, dx);
        track.holding = false;
        this.trySpawn(track);
        continue;
      }
      const profile = VEHICLE_TYPES[track.objectType] ? VEHICLE_CHASE : PERSON_CHASE;
      const settleM = track.holding ? 2 * profile.settleM : profile.settleM;
      track.holding = remaining < settleM || !reachableForward(profile.turnRadiusM, state.headingRad, dx, dz);
      if (track.holding) {
        this.world.actHold(track.actorId);
      } else {
        this.world.actChase(track.actorId, track.target, Math.min(profile.maxSpeedMps, remaining / RESPONSE_S));
      }
    }
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.lastActUpdate = 0;
    for (const track of this.tracks.values()) {
      if (track.actorId) {
        const state = this.world.actorState(track.actorId);
        if (state) track.target = { x: state.x, z: state.z };
        this.world.despawn(track.actorId);
        track.actorId = null;
      }
      this.trySpawn(track);
    }
  }

  expire(now: number): void {
    for (const [objectId, track] of [...this.tracks]) {
      if (now - track.lastSeen <= this.despawnAfterS) continue;
      if (track.actorId) this.world.despawn(track.actorId);
      this.tracks.delete(objectId);
    }
  }

  clear(): void {
    for (const track of this.tracks.values()) {
      if (track.actorId) this.world.despawn(track.actorId);
    }
    this.tracks.clear();
  }

  /** v1 `_track_status` shape (actor ids are engine strings). */
  trackStatus(): Array<Record<string, unknown>> {
    return [...this.tracks.keys()].sort().map((objectId) => {
      const track = this.tracks.get(objectId)!;
      const state = track.actorId ? this.world.actorState(track.actorId) : undefined;
      const det = track.record;
      const gps = state
        ? wgs84FromScene(this.world.frame, { x: state.x, z: state.z })
        : null;
      return {
        object_id: track.objectId,
        object_type: track.objectType,
        event_id: det.event_id ?? null,
        detection_timestamp_utc: det.timestamp_utc ?? null,
        media_timestamp_utc: det.media_timestamp_utc ?? null,
        timestamp_schema_version: det.timestamp_schema_version ?? null,
        media_time_trusted: det.media_time_trusted === true,
        media_clock: det.media_clock ?? null,
        device_id: det.device_id ?? null,
        track_id: det.track_id ?? null,
        bbox: det.bbox ?? null,
        gps_location: det.gps_location ?? (gps ? { lat: gps.lat, lon: gps.lon } : null),
        tracked_actor_id: track.actorId,
        actor_id: state ? track.actorId : null,
        actor_present: state !== undefined,
        actor_type: state ? `twin.${track.objectType}` : null,
        transform: state
          ? {
              location: { x: state.x, y: state.z, z: 0 },
              rotation: { pitch: 0, yaw: legacyYawDegFromSceneHeading(state.headingRad), roll: 0 },
            }
          : null,
      };
    });
  }
}

/**
 * Whether a forward-only body at `headingRad` (scene) can drive to the offset
 * (dx, dz) without looping: the point must be ahead and outside both
 * minimum-radius turning circles.
 */
function reachableForward(turnRadiusM: number, headingRad: number, dx: number, dz: number): boolean {
  if (turnRadiusM === 0) return true;
  // Scene z is negated local y; the local heading is the negated scene heading.
  const h = -headingRad;
  const ly = -dz;
  const forward = dx * Math.cos(h) + ly * Math.sin(h);
  const lateral = -dx * Math.sin(h) + ly * Math.cos(h);
  if (forward <= 0) return false;
  return Math.hypot(forward, Math.abs(lateral) - turnRadiusM) >= turnRadiusM;
}
