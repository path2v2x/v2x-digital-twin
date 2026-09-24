/**
 * TwinWorld — one long-lived SimForge WorldSession on the site map, ticked at
 * 20 Hz, with:
 *  - per-client truth_frame fan-out (verbatim engine bytes),
 *  - a spawn/act/despawn command surface used by every protocol feature,
 *  - actor metadata (category/blueprint) the JSON protocol needs on top of
 *    the engine's truth.
 *
 * Engine facts this module encodes (validated by scripts/exp-*.ts):
 *  - Actors retire forever once routeS reaches route end, so externally
 *    driven actors (ego, ghosts) get a 10 km freeform polyline route and are
 *    moved exclusively by zero-order-hold act overrides.
 *  - `control` overrides bypass the setpoint governor (keyboard driving,
 *    one-tick latency); preview/targetSpeed overrides steer ghosts.
 *  - timedPolyline routes make time own motion (trajectory playback,
 *    keyframes at absolute sim time).
 *  - The session runs in live mode: spawn/despawn mutate the running engine
 *    instead of rebuilding and replaying the whole session from t = 0, which
 *    in clip mode made every ghost spawn cost the server's full uptime.
 */
import {
  buildMapControlPlan,
  normalizeDerivedMapIndex,
  parseMapSignalCatalog,
  topologyWithMapSpeedLimits,
} from '@simforge-oss/compiler';
import type { MapBundle } from '@simforge-oss/compiler/node';
import {
  buildLaneGraph,
  DEFAULT_ACTOR_DIMS,
  localFromScene,
  parseSimScenarioInput,
  type ActorKind,
  type Dims,
  type RouteSpec,
  type SimScenarioInput,
} from '@simforge-oss/engine';
import { WorldSession, type SpawnRequest, type TruthSubscription, type WorldActorState, type WorldCommand } from '@simforge-oss/training-env';
import type { LegacyFlatEarthFrame } from '@simforge-oss/maps';
import { flatEarthFromXodr, sceneHeadingFromLegacyYawDeg, type SceneXZ } from './geo.js';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import type { TwinConfig } from './config.js';

export type ActorCategory =
  | 'ego'
  | 'placed'
  | 'dynamic'
  | 'traffic'
  | 'ghost'
  | 'trajectory'
  | 'scenario'
  | 'reconstruction';

export interface ActorMeta {
  readonly id: string;
  readonly category: ActorCategory;
  readonly kind: ActorKind;
  readonly blueprint: string;
  readonly name: string;
  /** EVA participation: true for firetruck spawns. */
  readonly firetruck: boolean;
  /** dynamic actors: moving circular geofence. */
  readonly geofenceRadiusM?: number;
  readonly geofenceMessage?: string;
  /** owning /drive session (session-owned cleanup), if any. */
  readonly ownerSession?: string;
}

export interface TruthSink {
  /** Called with each freshly committed framed truth message. */
  (bytes: Uint8Array): void;
}

const FREEFORM_ROUTE_LENGTH_M = 10_000;
/** Delay before retrying a re-root that had to be deferred. */
const REROOT_RETRY_S = 30;

type WorldAction = Extract<WorldCommand, { kind: 'act' }>['action'];

/** Map a drive-protocol blueprint id onto an engine actor kind. */
export function kindForBlueprint(blueprint: string): ActorKind {
  const bp = blueprint.toLowerCase();
  if (bp.startsWith('walker.')) return 'pedestrian';
  if (bp.startsWith('static.')) return 'static_object';
  if (bp.includes('firetruck') || bp.includes('ambulance')) return 'truck';
  for (const kind of ['truck', 'bus', 'van', 'motorcycle', 'bicycle'] as const) {
    if (bp.includes(kind)) return kind;
  }
  if (bp.includes('bike')) return 'bicycle';
  if (bp.includes('sprinter') || bp.includes('cybertruck')) return 'van';
  return 'car';
}

export function displayNameFromBlueprint(blueprint: string): string {
  const parts = blueprint.split('.');
  if (parts.length >= 3) {
    const make = parts[1]!.charAt(0).toUpperCase() + parts[1]!.slice(1);
    const model = parts[2]!.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return `${make} ${model}`;
  }
  return blueprint;
}

let commandSeq = 0;

export class TwinWorld {
  readonly bundle: MapBundle;
  readonly frame: LegacyFlatEarthFrame;
  readonly xodrSha256: string;
  readonly dt: number;
  readonly meta = new Map<string, ActorMeta>();
  private current: WorldSession;
  private readonly baseInput: SimScenarioInput;
  private readonly epochSeconds: number;
  /** Session time of the current epoch at which the next re-root is attempted. */
  private nextRerootAtS: number;
  /** World time at which the current session's clock reads zero. */
  private epochOffsetS = 0;
  private actorSerial = 0;
  /** Spawn request of every present actor, re-materialized when the session is re-rooted. */
  private readonly specs = new Map<string, SpawnRequest>();
  /** Latest zero-order-hold action per actor, re-issued after a re-root. */
  private readonly acts = new Map<string, WorldAction>();
  private readonly sinks = new Set<{ sink: TruthSink; sub: TruthSubscription }>();
  private readonly tickHooks = new Set<(tS: number) => void>();
  private timer: NodeJS.Timeout | null = null;
  private spawnPoints: Array<{ x: number; z: number; headingRad: number }> = [];
  /** Spawn points inside the streamed browser tile bundle (preferred for the ego). */
  private coveredSpawnPoints: Array<{ x: number; z: number; headingRad: number }> = [];
  private tileCoverage: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];

  private constructor(bundle: MapBundle, frame: LegacyFlatEarthFrame, xodrSha256: string, baseInput: SimScenarioInput, dt: number, epochSeconds: number) {
    this.bundle = bundle;
    this.frame = frame;
    this.xodrSha256 = xodrSha256;
    this.baseInput = baseInput;
    this.dt = dt;
    this.epochSeconds = epochSeconds;
    this.nextRerootAtS = epochSeconds;
    this.current = this.openSession();
  }

  /** The engine session of the current epoch; replaced whenever the world is re-rooted. */
  get session(): WorldSession {
    return this.current;
  }

  private openSession(): WorldSession {
    const session = new WorldSession({ input: this.baseInput, graph: this.bundle.graph, mode: 'live' });
    // Move past t = 0 before any client can issue an act.
    session.advance(1);
    return session;
  }

  static async create(config: TwinConfig): Promise<TwinWorld> {
    const bundle = loadTwinMap(config.mapId, config.mapBundleDir);
    const frame = flatEarthFromXodr(path.join(config.mapBundleDir, 'map.xodr'));
    const plan = buildMapControlPlan({
      index: bundle.index,
      graph: bundle.graph,
      topology: bundle.topology,
      signalCatalog: bundle.signalCatalog,
    });
    const input: SimScenarioInput = parseSimScenarioInput({
      mapId: config.mapId,
      dt: config.tickDt,
      warmupSeconds: 0,
      clipSeconds: 60,
      seed: 'v2x-twin-server',
      actors: [],
      interactions: [],
      signalPrograms: plan.signalPrograms,
      operationalConditions: {},
    });
    const world = new TwinWorld(bundle, frame, world0Sha(bundle), input, config.tickDt, config.sessionEpochSeconds);
    world.tileCoverage = TwinWorld.readTileCoverage(config.mapBundleDir);
    world.buildSpawnPoints();
    return world;
  }

  /** Deterministic road spawn points: directed midpoints of drivable lanes >= 20 m. */
  private buildSpawnPoints(): void {
    const graph = this.bundle.graph;
    const points: Array<{ x: number; z: number; headingRad: number }> = [];
    for (const rsl of graph.laneRsls()) {
      const geom = graph.geometry(rsl);
      if (!geom || geom.lane.laneType !== 'driving' || geom.lane.isJunction) continue;
      if (geom.lengthM < 20) continue;
      const reversed = graph.nominalReversed(rsl) ?? false;
      const sample = graph.sampleDirected({ rsl, reversed }, geom.lengthM / 2);
      points.push({ x: sample.point.x, z: -sample.point.y, headingRad: -sample.headingRad });
    }
    this.spawnPoints = points;
    // The XODR road network is larger than the streamed browser tile bundle, so an
    // unfiltered pick can drop the ego on unmapped ground (a white void in the
    // client). Prefer spawn points inside the tiles the viewer actually streams.
    const covered = points.filter((p) => this.tileCoverage.some((b) => p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ));
    this.coveredSpawnPoints = covered;
  }

  /** Union of streamed tile AABBs (XZ) from the bundle's browser manifest (`3d/manifest.json`; tiles themselves are not shipped in-repo). */
  private static readTileCoverage(mapBundleDir: string): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
    try {
      const manifest = JSON.parse(readFileSync(path.join(mapBundleDir, '3d', 'manifest.json'), 'utf8')) as {
        tiles?: Array<{ bounds?: { min?: number[]; max?: number[] } }>;
      };
      const boxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
      for (const tile of manifest.tiles ?? []) {
        const min = tile.bounds?.min;
        const max = tile.bounds?.max;
        if (!min || !max || min.length < 3 || max.length < 3) continue;
        boxes.push({ minX: min[0]!, maxX: max[0]!, minZ: min[2]!, maxZ: max[2]! });
      }
      return boxes;
    } catch {
      return [];
    }
  }

  /** Spawn-pool sizes: total road points vs those inside streamed tile coverage. */
  spawnPointStats(): { total: number; covered: number } {
    return { total: this.spawnPoints.length, covered: this.coveredSpawnPoints.length };
  }

  randomSpawnPoint(): { x: number; z: number; headingRad: number } {
    const pool = this.coveredSpawnPoints.length > 0 ? this.coveredSpawnPoints : this.spawnPoints;
    if (pool.length === 0) throw new Error('No spawn points available');
    return pool[Math.floor(Math.random() * pool.length)]!;
  }


  /* ------------------------------------------------------------- tick loop */

  start(): void {
    if (this.timer) return;
    const periodMs = this.dt * 1000;
    let last = process.hrtime.bigint();
    let carry = 0;
    this.timer = setInterval(() => {
      const now = process.hrtime.bigint();
      const elapsedMs = Number(now - last) / 1e6 + carry;
      last = now;
      const ticks = Math.max(1, Math.min(5, Math.round(elapsedMs / periodMs)));
      carry = elapsedMs - ticks * periodMs;
      if (carry < -periodMs) carry = -periodMs;
      this.advanceTicks(ticks);
    }, periodMs);
  }

  /** One deterministic step of the server loop: advance, hooks, truth flush. */
  advanceTicks(ticks: number): void {
    this.current.advance(ticks);
    const tS = this.time();
    for (const hook of this.tickHooks) {
      try {
        hook(tS);
      } catch (error) {
        console.error('[twin-world] tick hook failed:', error);
      }
    }
    this.flushTruth();
    if (this.current.time() >= this.nextRerootAtS) this.reroot();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Register a per-tick hook (ghost driver, alert evaluation, ...). */
  onTick(hook: (tS: number) => void): () => void {
    this.tickHooks.add(hook);
    return () => this.tickHooks.delete(hook);
  }

  /* ------------------------------------------------------- truth fan-out */

  subscribe(sink: TruthSink): () => void {
    const entry = { sink, sub: this.current.subscribeTruth({ capacity: 256 }) };
    this.sinks.add(entry);
    return () => {
      this.sinks.delete(entry);
      entry.sub.unsubscribe();
    };
  }

  private flushTruth(): void {
    for (const entry of this.sinks) {
      for (const bytes of entry.sub.drain()) entry.sink(bytes);
    }
  }

  /* ------------------------------------------------------------ commands */

  /** World time, continuous across re-roots. */
  time(): number {
    return this.epochOffsetS + this.current.time();
  }

  actorState(id: string): WorldActorState | undefined {
    return this.current.snapshot().actors.find((a) => a.id === id && a.present);
  }

  presentActors(): WorldActorState[] {
    return this.current.snapshot().actors.filter((a) => a.present);
  }

  /**
   * Spawn an externally driven actor: freeform 10 km polyline route so the
   * engine never retires it; motion comes from act overrides only.
   */
  spawnFreeform(options: {
    category: ActorCategory;
    kind: ActorKind;
    blueprint: string;
    pose: { x: number; z: number; headingRad: number };
    speedMps?: number;
    dims?: Dims;
    meta?: Partial<Pick<ActorMeta, 'geofenceRadiusM' | 'geofenceMessage' | 'ownerSession' | 'name'>>;
  }): { ok: true; id: string } | { ok: false; error: string } {
    const { pose } = options;
    return this.spawn({ ...options, spawn: { kind: options.kind, pose, speedMps: options.speedMps ?? 0, snapToLane: false, route: freeformRoute(pose), ...(options.dims ? { dims: options.dims } : {}) } });
  }

  spawn(options: {
    category: ActorCategory;
    kind: ActorKind;
    blueprint: string;
    spawn: SpawnRequest;
    meta?: Partial<Pick<ActorMeta, 'geofenceRadiusM' | 'geofenceMessage' | 'ownerSession' | 'name'>>;
  }): { ok: true; id: string } | { ok: false; error: string } {
    // Ids are allocated here, never by the engine, so they stay unique across re-roots.
    const spawn: SpawnRequest = { ...options.spawn, id: options.spawn.id ?? `tw:${++this.actorSerial}` };
    const outcome = this.current.applyCommand('twin', ++commandSeq, { kind: 'spawn', spawn });
    if (!outcome.ok || !outcome.actorIds?.length) {
      return { ok: false, error: outcome.error ?? 'spawn rejected' };
    }
    const id = outcome.actorIds[0]!;
    this.specs.set(id, spawn);
    const blueprint = options.blueprint;
    this.meta.set(id, {
      id,
      category: options.category,
      kind: options.kind,
      blueprint,
      name: options.meta?.name ?? displayNameFromBlueprint(blueprint),
      firetruck: blueprint.toLowerCase().includes('firetruck'),
      ...(options.meta?.geofenceRadiusM !== undefined ? { geofenceRadiusM: options.meta.geofenceRadiusM } : {}),
      ...(options.meta?.geofenceMessage !== undefined ? { geofenceMessage: options.meta.geofenceMessage } : {}),
      ...(options.meta?.ownerSession !== undefined ? { ownerSession: options.meta.ownerSession } : {}),
    });
    return { ok: true, id };
  }

  despawn(id: string): boolean {
    const outcome = this.current.applyCommand('twin', ++commandSeq, { kind: 'despawn', actorId: id });
    this.meta.delete(id);
    this.specs.delete(id);
    this.acts.delete(id);
    return outcome.ok;
  }

  /** Keyboard control (zero-order hold until the next control message). */
  actControl(id: string, control: { throttle: number; brake: number; steer: number }, reverse: boolean): boolean {
    return this.act(id, { control, motionDirection: reverse ? -1 : 1 });
  }

  /** Ghost steering: chase a scene-space target at a speed (zero-order hold). */
  actChase(id: string, target: SceneXZ, targetSpeedMps: number): boolean {
    const state = this.actorState(id);
    if (!state) return false;
    const local = localFromScene(target);
    const cur = localFromScene({ x: state.x, z: state.z });
    const headingRad = Math.atan2(local.y - cur.y, local.x - cur.x);
    return this.act(id, { previewPoint: local, previewHeadingRad: headingRad, targetSpeedMps });
  }

  actRelease(id: string): void {
    this.act(id, null);
  }

  private act(id: string, action: WorldAction): boolean {
    const outcome = this.current.applyCommand('twin', ++commandSeq, { kind: 'act', actorId: id, action });
    if (outcome.ok) {
      if (action === null) this.acts.delete(id);
      else this.acts.set(id, action);
    }
    return outcome.ok;
  }

  /** Spawn a timed-route actor whose keyframes are seconds-from-now offsets. */
  spawnTimedRoute(options: {
    category: ActorCategory;
    kind: ActorKind;
    blueprint: string;
    points: Array<{ t: number; x: number; z: number }>;
    dims?: Dims;
    meta?: Partial<Pick<ActorMeta, 'ownerSession' | 'name'>>;
  }): { ok: true; id: string } | { ok: false; error: string } {
    // Timed-route keyframes are times on the current session's clock.
    const t0 = this.current.time() + this.dt;
    const first = options.points[0]!;
    const second = options.points.find((p) => Math.hypot(p.x - first.x, p.z - first.z) > 0.5) ?? first;
    const headingRad = second === first ? 0 : -Math.atan2(-(second.z - first.z), second.x - first.x);
    const route: RouteSpec = {
      kind: 'timedPolyline',
      points: options.points.map((p) => ({ timeS: t0 + p.t, x: p.x, z: p.z })),
    };
    return this.spawn({
      category: options.category,
      kind: options.kind,
      blueprint: options.blueprint,
      spawn: {
        kind: options.kind,
        pose: { x: first.x, z: first.z, headingRad },
        speedMps: 0,
        snapToLane: false,
        route,
        ...(options.dims ? { dims: options.dims } : {}),
      },
      ...(options.meta ? { meta: options.meta } : {}),
    });
  }

  /** All present actors of a category. */
  byCategory(category: ActorCategory): Array<{ meta: ActorMeta; state: WorldActorState }> {
    const out: Array<{ meta: ActorMeta; state: WorldActorState }> = [];
    const states = new Map(this.presentActors().map((a) => [a.id, a]));
    for (const meta of this.meta.values()) {
      if (meta.category !== category) continue;
      const state = states.get(meta.id);
      if (state) out.push({ meta, state });
    }
    return out;
  }

  /** Convert a drive-protocol flat-earth pose into scene coordinates. */
  poseFromLegacy(x: number, y: number, yawDeg: number): { x: number; z: number; headingRad: number } {
    return { x, z: y, headingRad: sceneHeadingFromLegacyYawDeg(yawDeg) };
  }

  /**
   * Start a fresh session that holds only the actors present now, under their
   * existing ids and current motion. A live session keeps every actor it ever
   * spawned, so each spawn and despawn slows as the world ages; re-rooting
   * bounds that cost. Deferred while a lane-routed actor is mid-route.
   */
  private reroot(): void {
    const previous = this.current;
    const elapsedS = previous.time();
    const present = previous.snapshot().actors.filter((actor) => actor.present);
    const next = this.openSession();
    const shiftS = next.time() - elapsedS;
    const carried: Array<{ spawn: SpawnRequest; required: boolean }> = [];
    for (const actor of present) {
      const spec = this.specs.get(actor.id);
      const spawn = spec ? rematerialize(spec, actor, shiftS, next.time()) : null;
      if (!spawn) {
        this.nextRerootAtS = elapsedS + REROOT_RETRY_S;
        return;
      }
      carried.push({ spawn, required: this.meta.get(actor.id)?.category !== 'ghost' });
    }

    const kept = new Map<string, SpawnRequest>();
    for (const { spawn, required } of carried) {
      const outcome = next.applyCommand('twin', ++commandSeq, { kind: 'spawn', spawn });
      if (outcome.ok) {
        kept.set(spawn.id!, spawn);
      } else if (required) {
        console.warn(`[twin-world] re-root deferred: ${spawn.id} could not be carried over (${outcome.error ?? 'spawn rejected'})`);
        this.nextRerootAtS = elapsedS + REROOT_RETRY_S;
        return;
      }
    }
    for (const [id, action] of this.acts) {
      if (kept.has(id)) next.applyCommand('twin', ++commandSeq, { kind: 'act', actorId: id, action });
    }

    for (const entry of this.sinks) {
      entry.sub.unsubscribe();
      entry.sub = next.subscribeTruth({ capacity: 256 });
    }
    this.epochOffsetS -= shiftS;
    this.current = next;
    this.nextRerootAtS = this.epochSeconds;
    this.specs.clear();
    for (const [id, spawn] of kept) this.specs.set(id, spawn);
    for (const id of [...this.acts.keys()]) if (!kept.has(id)) this.acts.delete(id);
    for (const id of [...this.meta.keys()]) if (!kept.has(id)) this.meta.delete(id);
    console.log(`[twin-world] session re-rooted at t=${this.time().toFixed(1)}s: ${kept.size} actors carried over, ${present.length - kept.size} ghosts dropped`);
  }
}

/** A 10 km straight polyline from the pose along its heading, so the engine never retires the actor. */
function freeformRoute(pose: { x: number; z: number; headingRad: number }): RouteSpec {
  return {
    kind: 'polyline',
    points: [
      { x: pose.x, z: pose.z },
      {
        x: pose.x + FREEFORM_ROUTE_LENGTH_M * Math.cos(-pose.headingRad),
        z: pose.z + FREEFORM_ROUTE_LENGTH_M * -Math.sin(-pose.headingRad),
      },
    ],
  };
}

/**
 * The spawn request that continues `actor` in a fresh session whose clock is
 * `shiftS` ahead of the old one (negative: it restarts near zero). Null when
 * the actor follows a lane route, which cannot be resumed mid-route.
 */
function rematerialize(spec: SpawnRequest, actor: WorldActorState, shiftS: number, nowS: number): SpawnRequest | null {
  const pose = { x: actor.x, z: actor.z, headingRad: actor.headingRad };
  const carried = {
    id: actor.id,
    kind: spec.kind,
    pose,
    snapToLane: false,
    ...(spec.dims ? { dims: spec.dims } : {}),
    ...(spec.tags ? { tags: spec.tags } : {}),
    ...(spec.cruiseSpeedMps !== undefined ? { cruiseSpeedMps: spec.cruiseSpeedMps } : {}),
  };
  if (spec.static) {
    return { ...carried, static: true, speedMps: 0, route: { kind: 'polyline', points: [{ x: pose.x, z: pose.z }] } };
  }
  const route = spec.route;
  if (route?.kind === 'timedPolyline') {
    const ahead = route.points.map((point) => ({ ...point, timeS: point.timeS + shiftS })).filter((point) => point.timeS > nowS);
    return {
      ...carried,
      speedMps: 0,
      route: ahead.length > 0
        ? { kind: 'timedPolyline', points: [{ timeS: nowS, x: pose.x, z: pose.z }, ...ahead] }
        : { kind: 'polyline', points: [{ x: pose.x, z: pose.z }] },
    };
  }
  if (route?.kind === 'polyline' && spec.snapToLane === false) {
    return { ...carried, speedMps: actor.speedMps, route: freeformRoute(pose) };
  }
  return null;
}

function readJsonArtifact(file: string): unknown {
  const bytes = readFileSync(file);
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(plain.toString('utf8')) as unknown;
}

function loadTwinMap(mapId: string, bundleDir: string): MapBundle {
  const xodr = readFileSync(path.join(bundleDir, 'map.xodr'), 'utf8');
  const rawTopology = readJsonArtifact(path.join(bundleDir, 'topology-index.json.gz')) as Parameters<typeof topologyWithMapSpeedLimits>[0];
  const derived = readJsonArtifact(path.join(bundleDir, 'derived', 'topology-derived.json.gz')) as MapBundle['derived'];
  const catalog = readJsonArtifact(path.join(bundleDir, 'derived', 'locations.json.gz')) as MapBundle['catalog'];
  const signals = readJsonArtifact(path.join(bundleDir, 'signals.geojson.gz')) as Parameters<typeof parseMapSignalCatalog>[1];
  const signalCatalog = parseMapSignalCatalog(xodr, signals);
  const topology = topologyWithMapSpeedLimits(rawTopology, signalCatalog);
  const normalizeOptions: NonNullable<Parameters<typeof normalizeDerivedMapIndex>[1]> = {
    mapId,
    topology: topology as NonNullable<NonNullable<Parameters<typeof normalizeDerivedMapIndex>[1]>['topology']>,
    locations: catalog,
  };
  const index = normalizeDerivedMapIndex(derived, normalizeOptions);
  const graph = buildLaneGraph(topology);
  return { mapId, catalog, derived, topology, index, graph, signalCatalog };
}

function world0Sha(bundle: MapBundle): string {
  return bundle.graph.topologyDigest;
}

export { DEFAULT_ACTOR_DIMS };
