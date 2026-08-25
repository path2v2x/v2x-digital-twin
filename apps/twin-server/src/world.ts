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
 *  - Acts must never be issued at t <= 0 (the warmup tick replays with the
 *    act timeline on structural rebuilds); the server advances one tick
 *    before accepting clients.
 */
import { loadMap, buildMapControlPlan, type MapBundle } from '@simforge/compiler/node';
import {
  DEFAULT_ACTOR_DIMS,
  localFromScene,
  parseSimScenarioInput,
  type ActorKind,
  type Dims,
  type RouteSpec,
  type SimScenarioInput,
} from '@simforge/engine';
import { WorldSession, type SpawnRequest, type TruthSubscription, type WorldActorState } from '@simforge/training-env';
import type { LegacyFlatEarthFrame } from '@simforge/maps';
import { flatEarthFromXodr, sceneHeadingFromCarlaYawDeg, type SceneXZ } from './geo.js';
import path from 'node:path';
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
  /** EVA participation: true for vehicle.carlamotors.firetruck spawns. */
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

/** Map a v1 CARLA blueprint id onto an engine actor kind. */
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
  readonly session: WorldSession;
  readonly dt: number;
  readonly meta = new Map<string, ActorMeta>();
  private readonly sinks = new Set<{ sink: TruthSink; sub: TruthSubscription }>();
  private readonly tickHooks = new Set<(tS: number) => void>();
  private timer: NodeJS.Timeout | null = null;
  private spawnPoints: Array<{ x: number; z: number; headingRad: number }> = [];

  private constructor(bundle: MapBundle, frame: LegacyFlatEarthFrame, xodrSha256: string, session: WorldSession, dt: number) {
    this.bundle = bundle;
    this.frame = frame;
    this.xodrSha256 = xodrSha256;
    this.session = session;
    this.dt = dt;
  }

  static async create(config: TwinConfig): Promise<TwinWorld> {
    // loadMap resolves dev-assets/<mapId>; point it at the bundle's parent.
    process.env['SCEN_DEV_ASSETS'] = path.dirname(config.mapBundleDir);
    const bundle = await loadMap(config.mapId);
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
    const session = new WorldSession({ input, graph: bundle.graph, horizonSeconds: config.horizonSeconds });
    const world = new TwinWorld(bundle, frame, world0Sha(bundle), session, config.tickDt);
    world.buildSpawnPoints();
    // Move past t = 0 before any client can issue an act (rebuild determinism).
    session.advance(1);
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
  }

  randomSpawnPoint(): { x: number; z: number; headingRad: number } {
    if (this.spawnPoints.length === 0) throw new Error('No spawn points available');
    return this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)]!;
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
      this.session.advance(ticks);
      const tS = this.session.time();
      for (const hook of this.tickHooks) {
        try {
          hook(tS);
        } catch (error) {
          console.error('[twin-world] tick hook failed:', error);
        }
      }
      this.flushTruth();
    }, periodMs);
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
    const entry = { sink, sub: this.session.subscribeTruth({ capacity: 256 }) };
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

  time(): number {
    return this.session.time();
  }

  actorState(id: string): WorldActorState | undefined {
    return this.session.snapshot().actors.find((a) => a.id === id && a.present);
  }

  presentActors(): WorldActorState[] {
    return this.session.snapshot().actors.filter((a) => a.present);
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
    const route: RouteSpec = {
      kind: 'polyline',
      points: [
        { x: pose.x, z: pose.z },
        {
          x: pose.x + FREEFORM_ROUTE_LENGTH_M * Math.cos(-pose.headingRad),
          z: pose.z + FREEFORM_ROUTE_LENGTH_M * -Math.sin(-pose.headingRad),
        },
      ],
    };
    return this.spawn({ ...options, spawn: { kind: options.kind, pose, speedMps: options.speedMps ?? 0, snapToLane: false, route, ...(options.dims ? { dims: options.dims } : {}) } });
  }

  spawn(options: {
    category: ActorCategory;
    kind: ActorKind;
    blueprint: string;
    spawn: SpawnRequest;
    meta?: Partial<Pick<ActorMeta, 'geofenceRadiusM' | 'geofenceMessage' | 'ownerSession' | 'name'>>;
  }): { ok: true; id: string } | { ok: false; error: string } {
    const outcome = this.session.applyCommand('twin', ++commandSeq, { kind: 'spawn', spawn: options.spawn });
    if (!outcome.ok || !outcome.actorIds?.length) {
      return { ok: false, error: outcome.error ?? 'spawn rejected' };
    }
    const id = outcome.actorIds[0]!;
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
    const outcome = this.session.applyCommand('twin', ++commandSeq, { kind: 'despawn', actorId: id });
    this.meta.delete(id);
    return outcome.ok;
  }

  /** Keyboard control (zero-order hold until the next control message). */
  actControl(id: string, control: { throttle: number; brake: number; steer: number }, reverse: boolean): boolean {
    const outcome = this.session.applyCommand('twin', ++commandSeq, {
      kind: 'act',
      actorId: id,
      action: { control, motionDirection: reverse ? -1 : 1 },
    });
    return outcome.ok;
  }

  /** Ghost steering: chase a scene-space target at a speed (zero-order hold). */
  actChase(id: string, target: SceneXZ, targetSpeedMps: number): boolean {
    const state = this.actorState(id);
    if (!state) return false;
    const local = localFromScene(target);
    const cur = localFromScene({ x: state.x, z: state.z });
    const headingRad = Math.atan2(local.y - cur.y, local.x - cur.x);
    const outcome = this.session.applyCommand('twin', ++commandSeq, {
      kind: 'act',
      actorId: id,
      action: { previewPoint: local, previewHeadingRad: headingRad, targetSpeedMps },
    });
    return outcome.ok;
  }

  actRelease(id: string): void {
    this.session.applyCommand('twin', ++commandSeq, { kind: 'act', actorId: id, action: null });
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
    const t0 = this.time() + this.dt;
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

  /** Convenience for scene pose from a carla-frame spawn (yaw degrees). */
  poseFromCarla(x: number, y: number, yawDeg: number): { x: number; z: number; headingRad: number } {
    return { x, z: y, headingRad: sceneHeadingFromCarlaYawDeg(yawDeg) };
  }
}

function world0Sha(bundle: MapBundle): string {
  return bundle.graph.topologyDigest;
}

export { DEFAULT_ACTOR_DIMS };
