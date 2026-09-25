/**
 * TwinSync port — detection mirroring as physics-light ghost actors.
 *
 * Semantics ported from apps/bridge/digital_twin_bridge/twin_sync.py:
 *  - accepted object types: car | truck | bus | person (person → pedestrian);
 *  - a track upserts on every detection record {object_id, object_type,
 *    gps_location{lat, lon}, confidence};
 *  - spawn at the flat-earth point (vehicle types adopt lane height/yaw when
 *    the detection lies within 4 m of a lane, like the v1 waypoint snap);
 *  - fixes feed a per-track alpha-beta filter (position + velocity, world
 *    time), which absorbs monocular jitter;
 *  - motion: the engine's dynamic body follows the filtered estimate via
 *    zero-order-hold act overrides (v1 lerped transforms). Moving objects are
 *    pursued at a lookahead point along their estimated velocity with speed
 *    feed-forward; stopped objects are approached at a speed proportional to
 *    the gap, and inside the stop radius (or when a vehicle's target is behind
 *    it or inside its turning circle) the actor holds its heading instead of
 *    circling the point. Gaps beyond SNAP_M, or a chase blocked by a collision
 *    for STUCK_S, respawn the actor at the estimate;
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
const RESPONSE_S = 2;
/** Beyond this gap the actor is respawned at the fix rather than driven there. */
const SNAP_M = 15;
/**
 * Alpha-beta fix filter. Monocular fixes scatter by metres, so each fix moves
 * the position estimate by ALPHA of its residual and the velocity by BETA/dt
 * (critically damped: beta = alpha^2 / (2 - alpha)).
 */
const FILTER_ALPHA = 0.2;
const FILTER_BETA = (FILTER_ALPHA * FILTER_ALPHA) / (2 - FILTER_ALPHA);
/** Longest the estimate is extrapolated past the last fix. */
const MAX_EXTRAPOLATION_S = 0.5;
/** Estimated speed below which an object counts as stopped. */
const STOPPED_MPS = 0.4;
/** Moving objects are steered at a point this far ahead (in seconds of travel) along their estimated velocity. */
const LOOKAHEAD_S = 1.5;
/** A chase that moves less than STUCK_PROGRESS_M in STUCK_S (collision) respawns the actor at its target. */
const STUCK_S = 1;
const STUCK_PROGRESS_M = 0.3;

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
  /** Filtered scene-space position and velocity at world time `t` of the last fix. */
  estimate: { x: number; z: number; vx: number; vz: number; t: number } | null;
  /** Scene-space target: the estimate extrapolated to now. */
  target: SceneXZ;
  /** Local-frame heading (scene forward = (cos h, -sin h)) used when (re)spawning. */
  headingRad: number;
  holding: boolean;
  /** Position and world time at the start of the current progress window while chasing, or null. */
  stuckCheck: { x: number; z: number; t: number } | null;
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
          estimate: null,
          target: { x: 0, z: 0 },
          headingRad: 0,
          holding: false,
          stuckCheck: null,
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

      this.observe(track, this.placementFor(track, lat, lon));
      if (!track.actorId) this.trySpawn(track);
    }
    this.expire(now);
  }

  /** Fold one fix into the track's alpha-beta estimate (world time, so replay speed scales motion). */
  private observe(track: GhostTrack, fix: SceneXZ): void {
    const t = this.world.time();
    const prior = track.estimate;
    const dt = prior ? t - prior.t : 0;
    if (!prior || dt <= 0 || Math.hypot(fix.x - prior.x, fix.z - prior.z) > SNAP_M) {
      if (prior && dt <= 0) {
        // Several fixes in one tick: average the position, keep the velocity.
        prior.x += FILTER_ALPHA * (fix.x - prior.x);
        prior.z += FILTER_ALPHA * (fix.z - prior.z);
      } else {
        track.estimate = { x: fix.x, z: fix.z, vx: 0, vz: 0, t };
      }
    } else {
      const px = prior.x + prior.vx * dt;
      const pz = prior.z + prior.vz * dt;
      const rx = fix.x - px;
      const rz = fix.z - pz;
      let vx = prior.vx + (FILTER_BETA / dt) * rx;
      let vz = prior.vz + (FILTER_BETA / dt) * rz;
      const maxSpeed = (VEHICLE_TYPES[track.objectType] ? VEHICLE_CHASE : PERSON_CHASE).maxSpeedMps;
      const speed = Math.hypot(vx, vz);
      if (speed > maxSpeed) {
        vx *= maxSpeed / speed;
        vz *= maxSpeed / speed;
      }
      track.estimate = { x: px + FILTER_ALPHA * rx, z: pz + FILTER_ALPHA * rz, vx, vz, t };
    }
    track.target = this.extrapolate(track);
  }

  private extrapolate(track: GhostTrack): SceneXZ {
    const e = track.estimate!;
    const ahead = Math.min(Math.max(this.world.time() - e.t, 0), MAX_EXTRAPOLATION_S);
    return { x: e.x + e.vx * ahead, z: e.z + e.vz * ahead };
  }

  private estimatedSpeed(track: GhostTrack): number {
    const e = track.estimate;
    if (!e || this.world.time() - e.t > MAX_EXTRAPOLATION_S) return 0;
    return Math.hypot(e.vx, e.vz);
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
          track.headingRad = sample.headingRad;
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
      if (track.estimate) track.target = this.extrapolate(track);
      const dx = track.target.x - state.x;
      const dz = track.target.z - state.z;
      const remaining = Math.hypot(dx, dz);
      if (remaining > SNAP_M) {
        this.respawnAtTarget(track, dx, dz);
        continue;
      }
      const profile = VEHICLE_TYPES[track.objectType] ? VEHICLE_CHASE : PERSON_CHASE;
      const objectSpeed = this.estimatedSpeed(track);
      let aim = track.target;
      let speed = 0;
      if (objectSpeed >= STOPPED_MPS) {
        // Pure pursuit on the estimated track: heading follows the motion, speed closes the along-track gap.
        const e = track.estimate!;
        const ux = e.vx / objectSpeed;
        const uz = e.vz / objectSpeed;
        const lookaheadM = Math.max(objectSpeed * LOOKAHEAD_S, 2 * profile.settleM);
        aim = { x: track.target.x + ux * lookaheadM, z: track.target.z + uz * lookaheadM };
        track.holding = !reachableForward(profile.turnRadiusM, state.headingRad, aim.x - state.x, aim.z - state.z);
        speed = Math.min(profile.maxSpeedMps, Math.max(0, objectSpeed + (dx * ux + dz * uz) / RESPONSE_S));
      } else {
        const settleM = track.holding ? 2 * profile.settleM : profile.settleM;
        track.holding = remaining < settleM || !reachableForward(profile.turnRadiusM, state.headingRad, dx, dz);
        speed = Math.min(profile.maxSpeedMps, remaining / RESPONSE_S);
      }
      if (track.holding) {
        track.stuckCheck = null;
        this.world.actHold(track.actorId);
        continue;
      }
      // Ghosts collide (and the engine's collision-avoidance brakes them); two
      // tracks of one physical object, or a fix against a wall, can pin an
      // actor indefinitely, sometimes while its reported speed stays high. A
      // chase that moves under STUCK_PROGRESS_M in STUCK_S respawns at the
      // target; if that spot is occupied the spawn retries on later polls.
      const now = this.world.time();
      if (speed > 0.5) {
        const since = track.stuckCheck;
        if (!since) {
          track.stuckCheck = { x: state.x, z: state.z, t: now };
        } else if (now - since.t >= STUCK_S) {
          if (Math.hypot(state.x - since.x, state.z - since.z) < STUCK_PROGRESS_M) {
            this.respawnAtTarget(track, dx, dz);
            continue;
          }
          track.stuckCheck = { x: state.x, z: state.z, t: now };
        }
      } else {
        track.stuckCheck = null;
      }
      this.world.actChase(track.actorId, aim, speed);
    }
  }

  private respawnAtTarget(track: GhostTrack, dx: number, dz: number): void {
    this.world.despawn(track.actorId!);
    track.actorId = null;
    track.headingRad = -Math.atan2(dz, dx);
    track.holding = false;
    track.stuckCheck = null;
    this.trySpawn(track);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.lastActUpdate = 0;
    for (const track of this.tracks.values()) {
      if (track.actorId) {
        const state = this.world.actorState(track.actorId);
        if (state) {
          track.target = { x: state.x, z: state.z };
          track.estimate = { x: state.x, z: state.z, vx: 0, vz: 0, t: this.world.time() };
        }
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
 * Whether a forward-only body at `headingRad` can drive to the scene offset
 * (dx, dz) without looping: the point must be ahead and outside both
 * minimum-radius turning circles.
 */
function reachableForward(turnRadiusM: number, headingRad: number, dx: number, dz: number): boolean {
  if (turnRadiusM === 0) return true;
  // headingRad is measured in the local frame (x, y = -z).
  const h = headingRad;
  const ly = -dz;
  const forward = dx * Math.cos(h) + ly * Math.sin(h);
  const lateral = -dx * Math.sin(h) + ly * Math.cos(h);
  if (forward <= 0) return false;
  return Math.hypot(forward, Math.abs(lateral) - turnRadiusM) >= turnRadiusM;
}
