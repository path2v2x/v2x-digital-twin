/**
 * /drive session handler — the full v1 dispatch table
 * (drive_server.py handle_message) over the shared TwinWorld.
 * One DriveSession per WebSocket connection; request/response JSON plus the
 * connection-wide binary truth_frame relay (wired in server.ts).
 */
import type { ActorKind } from '@simforge-oss/engine';
import {
  evaProximityAlerts,
  evaYieldAlerts,
  geofenceAlerts,
  zoneAlerts,
  type V2xAlert,
  type V2xZone,
} from './alerts.js';
import type { TwinConfig } from './config.js';
import { legacyYawDegFromSceneHeading, planarDist, sceneFromWgs84 } from './geo.js';
import { parseUtcEpoch, type DetectionRecord } from './ghosts.js';
import type { ScenarioStore, PlacedObject } from './scenarios.js';
import type { TrafficController } from './traffic.js';
import type { TrajectoryPlayer } from './trajectory.js';
import type { TwinSync } from './twinsync.js';
import { appliedEnvironment, safeDriveWeather } from './weather.js';
import { displayNameFromBlueprint, kindForBlueprint, type TwinWorld } from './world.js';

type Json = Record<string, unknown>;

const TELEPORT_COORD_ABS_LIMIT_M = 100_000;
const TELEPORT_MAP_MARGIN_M = 500;
const TELEPORT_MAX_ROAD_DISTANCE_M = 100;
const TELEPORT_MIN_Z_M = -20;
const TELEPORT_MAX_Z_M = 500;
const TELEPORT_MAX_ABS_YAW_DEG = 360;
const TELEPORT_REQUEST_ID_MAX_LENGTH = 128;

const VEHICLE_BLUEPRINTS: ReadonlyArray<{ id: string; name: string; wheels: number }> = [
  { id: 'vehicle.tesla.model3', name: 'Tesla Model3', wheels: 4 },
  { id: 'vehicle.lincoln.mkz', name: 'Lincoln Mkz', wheels: 4 },
  { id: 'vehicle.dodge.charger', name: 'Dodge Charger', wheels: 4 },
  { id: 'vehicle.nissan.patrol', name: 'Nissan Patrol', wheels: 4 },
  { id: 'vehicle.mini.cooper', name: 'Mini Cooper', wheels: 4 },
  { id: 'vehicle.firetruck', name: 'Firetruck', wheels: 4 },
  { id: 'vehicle.mercedes.sprinter', name: 'Mercedes Sprinter', wheels: 4 },
  { id: 'vehicle.volkswagen.t2', name: 'Volkswagen T2', wheels: 4 },
  { id: 'vehicle.kawasaki.ninja', name: 'Kawasaki Ninja', wheels: 2 },
  { id: 'vehicle.bh.crossbike', name: 'Bh Crossbike', wheels: 2 },
];

const OBJECT_BLUEPRINTS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'static.prop.constructioncone', name: 'Construction Cone' },
  { id: 'static.prop.trafficwarning', name: 'Traffic Warning' },
  { id: 'static.prop.streetbarrier', name: 'Street Barrier' },
  { id: 'static.prop.box', name: 'Box' },
];

let sessionCounter = 0;
const activeSessions = new Set<DriveSession>();

export function activeSessionCount(): number {
  return [...activeSessions].filter((s) => s.isActive).length;
}

export interface DriveDeps {
  readonly world: TwinWorld;
  readonly config: TwinConfig;
  readonly sync: TwinSync;
  readonly traffic: TrafficController;
  readonly trajectories: TrajectoryPlayer;
  readonly scenarios: ScenarioStore;
}

export class DriveSession {
  private readonly deps: DriveDeps;
  readonly sessionId = `drive:${++sessionCounter}`;
  private egoId: string | null = null;
  private active = false;
  private zones: V2xZone[] = [];
  private readonly inFrontSince = new Map<string, number>();
  private placedObjects: Array<{ actorId: string; blueprint: string; pos: [number, number, number]; yaw: number }> = [];
  private reconstructionIds: string[] = [];
  private scenarioActorIds: string[] = [];
  private cameraView = 'chase';
  private cameraSettings = { width: 720, height: 720, fov: 90 };
  private lastControl = { steer: 0, throttle: 0, brake: 0 };

  constructor(deps: DriveDeps) {
    this.deps = deps;
    activeSessions.add(this);
  }

  get isActive(): boolean {
    return this.active;
  }

  dispose(): void {
    this.cleanup();
    activeSessions.delete(this);
  }

  async handle(msg: Json): Promise<Json> {
    const type = typeof msg['type'] === 'string' ? msg['type'] : '';
    try {
      return await this.dispatch(type, msg);
    } catch (error) {
      return { type: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async dispatch(type: string, msg: Json): Promise<Json> {
    const { world } = this.deps;
    switch (type) {
      case 'server_status':
        return { type: 'server_status', active_sessions: activeSessionCount(), this_session_active: this.active };
      case 'list_maps':
        return this.mapStatus();
      case 'set_map': {
        const requested = String(msg['map'] ?? '');
        if (requested !== this.deps.config.mapId) {
          return { type: 'error', message: `Map switching is unavailable: only ${this.deps.config.mapId} is loaded` };
        }
        return { ...this.mapStatus(), type: 'map_set' };
      }
      case 'list_vehicles':
        return { type: 'vehicle_list', vehicles: [...VEHICLE_BLUEPRINTS] };
      case 'list_objects':
        return { type: 'object_list', objects: [...OBJECT_BLUEPRINTS] };
      case 'start_session':
        return this.startSession(msg);
      case 'control':
        return this.control(msg);
      case 'respawn':
        return await this.respawn();
      case 'teleport':
        return await this.teleport(msg);
      case 'end_session':
        return this.end();
      case 'camera_switch': {
        const view = String(msg['view'] ?? '');
        if (!['chase', 'hood', 'bird', 'free'].includes(view)) {
          return { type: 'error', message: `Invalid camera view: ${view}` };
        }
        this.cameraView = view;
        return { type: 'camera_switched', view };
      }
      case 'set_camera_settings': {
        const params = (msg['params'] ?? {}) as Json;
        const num = (key: string, lo: number, hi: number, cur: number) => {
          const v = Number(params[key]);
          return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : cur;
        };
        this.cameraSettings = {
          width: Math.round(num('image_size_x', 480, 1280, this.cameraSettings.width)),
          height: Math.round(num('image_size_y', 480, 1280, this.cameraSettings.height)),
          fov: num('fov', 50, 110, this.cameraSettings.fov),
        };
        return { type: 'camera_settings_set', ...this.cameraSettings };
      }
      case 'set_weather': {
        this.requireActive();
        const safe = safeDriveWeather((msg['params'] ?? {}) as Json);
        return { type: 'weather_set', params: safe, applied: appliedEnvironment(safe) };
      }
      case 'spawn_traffic': {
        this.requireActive();
        const result = this.deps.traffic.spawnPreset(String(msg['preset'] ?? 'medium'));
        return { type: 'traffic_spawned', ...result };
      }
      case 'despawn_traffic': {
        this.requireActive();
        return { type: 'traffic_despawned', count: this.deps.traffic.despawnAll() };
      }
      case 'clear_non_ego_vehicles':
        return this.clearNonEgo();
      case 'sync_v2x_zones':
        return this.syncZones(Array.isArray(msg['zones']) ? (msg['zones'] as V2xZone[]) : []);
      case 'spawn_object':
        return this.spawnObject(String(msg['blueprint'] ?? ''), Number(msg['offset'] ?? 8));
      case 'undo_place':
        return this.undoPlace();
      case 'spawn_dynamic_actor':
        return this.spawnDynamicActor(
          String(msg['blueprint'] ?? ''),
          Number(msg['geofence_radius'] ?? 35),
          String(msg['message'] ?? ''),
        );
      case 'despawn_dynamic_actor':
        return this.despawnDynamicActor(String(msg['actor_id'] ?? ''));
      case 'despawn_dynamic_actors': {
        this.requireActive();
        let count = 0;
        for (const { meta } of world.byCategory('dynamic')) {
          if (meta.ownerSession === this.sessionId && world.despawn(meta.id)) count += 1;
        }
        return { type: 'dynamic_actors_despawned', count };
      }
      case 'list_scenarios':
        return { type: 'scenario_list', scenarios: this.deps.scenarios.list() };
      case 'load_scenario':
        return this.loadScenario(String(msg['file'] ?? ''));
      case 'save_scenario':
        return this.saveScenario(String(msg['name'] ?? ''), Array.isArray(msg['zones']) ? (msg['zones'] as unknown[]) : []);
      case 'delete_scenario': {
        const file = String(msg['file'] ?? '');
        this.deps.scenarios.deletePlacement(file);
        return { type: 'scenario_deleted', file };
      }
      case 'list_xosc_scenarios':
        return { type: 'xosc_list', scenarios: [], status: { running: false, scenario_runner_configured: false } };
      case 'start_xosc_scenario':
      case 'stop_xosc_scenario':
        return {
          type: 'error',
          message: 'OpenSCENARIO execution is unsupported; use list_scenarios/load_scenario (engine templates)',
        };
      case 'list_trajectories':
        return { type: 'trajectory_list', trajectories: this.deps.trajectories.listFiles(), status: this.deps.trajectories.status() };
      case 'upload_trajectory': {
        const data = msg['data'];
        if (!Array.isArray(data)) return { type: 'error', message: "trajectory 'data' must be a JSON array" };
        const file = this.deps.trajectories.saveFile(String(msg['name'] ?? 'uploaded'), data);
        return { type: 'trajectory_uploaded', file };
      }
      case 'start_trajectory': {
        const file = String(msg['file'] ?? '');
        if (file === '') return { type: 'error', message: "start_trajectory requires 'file'" };
        const result = this.deps.trajectories.start(file, String(msg['vehicle'] ?? 'vehicle.tesla.model3'));
        return { type: 'trajectory_started', ...result };
      }
      case 'stop_trajectory':
        return { type: 'trajectory_stopped', ...this.deps.trajectories.stop() };
      case 'trajectory_status':
        return { type: 'trajectory_status', ...this.deps.trajectories.status() };
      default:
        return { type: 'error', message: `Unknown message type: ${type}` };
    }
  }

  private mapStatus(): Json {
    return {
      type: 'map_status',
      current_map: this.deps.config.mapId,
      maps: [this.deps.config.mapId],
      mapId: this.deps.config.mapId,
      xodrSha256: this.deps.world.xodrSha256,
    };
  }

  private requireActive(): void {
    if (!this.active || this.egoId === null) throw new Error('No active session');
  }

  /* ------------------------------------------------------------ lifecycle */

  private startSession(msg: Json): Json {
    if (this.active) throw new Error('Session already active');
    const { world } = this.deps;

    // Historical reconstruction: latest recorded detection per object in the
    // requested window becomes a session-owned static actor (v1 spawned the
    // fetched scene as props).
    this.reconstructionIds = [];
    const startEpoch = parseUtcEpoch(msg['start']);
    const endEpoch = parseUtcEpoch(msg['end']);
    if (startEpoch !== null && endEpoch !== null) {
      const latestByObject = new Map<string, DetectionRecord>();
      for (const record of this.deps.sync.recordedInRange(startEpoch, endEpoch)) {
        latestByObject.set(record.object_id, record);
      }
      for (const record of latestByObject.values()) {
        const lat = record.gps_location?.lat;
        const lon = record.gps_location?.lon;
        if (lat === undefined || lon === undefined) continue;
        const objectType = record.object_type ?? 'car';
        const kind: ActorKind = objectType === 'person' ? 'pedestrian' : kindForBlueprint(`vehicle.${objectType}`);
        const scene = sceneFromWgs84(world.frame, lat, lon);
        const result = world.spawn({
          category: 'reconstruction',
          kind,
          blueprint: `recon.${objectType}`,
          spawn: { kind, pose: { x: scene.x, z: scene.z, headingRad: 0 }, speedMps: 0, snapToLane: false, static: true, route: { kind: 'polyline', points: [{ x: scene.x, z: scene.z }] } },
          meta: { name: record.object_id, ownerSession: this.sessionId },
        });
        if (result.ok) this.reconstructionIds.push(result.id);
      }
    }

    // Ego spawn: random road point, freeform 10 km route, keyboard-controlled.
    const requested = String(msg['vehicle'] ?? 'vehicle.tesla.model3');
    let ego: { ok: true; id: string } | { ok: false; error: string } = { ok: false, error: 'no spawn point' };
    for (let attempt = 0; attempt < 10 && !ego.ok; attempt++) {
      ego = world.spawnFreeform({
        category: 'ego',
        kind: kindForBlueprint(requested),
        blueprint: requested,
        pose: world.randomSpawnPoint(),
        meta: { ownerSession: this.sessionId, name: displayNameFromBlueprint(requested) },
      });
    }
    if (!ego.ok) throw new Error(`Failed to spawn vehicle: ${ego.error}`);
    this.egoId = ego.id;
    this.active = true;
    this.lastControl = { steer: 0, throttle: 0, brake: 0 };
    // v1 semantics: the ego stands still until the first control message. Without
    // this hold the engine would cruise the freeform route autonomously.
    world.actControl(ego.id, { throttle: 0, brake: 1, steer: 0 }, false);

    return {
      type: 'session_ready',
      vehicle_id: ego.id,
      objects_count: this.reconstructionIds.length,
      sensor_actor_ids: [],
      scene_actor_ids: [...this.reconstructionIds],
      owned_actor_ids: [ego.id, ...this.reconstructionIds],
    };
  }

  private control(msg: Json): Json {
    this.requireActive();
    const { world } = this.deps;
    const steer = Math.max(-1, Math.min(1, Number(msg['s'] ?? 0) || 0));
    const throttle = Math.max(0, Math.min(1, Number(msg['t'] ?? 0) || 0));
    const brake = Math.max(0, Math.min(1, Number(msg['b'] ?? 0) || 0));
    const reverse = msg['r'] === true;
    this.lastControl = { steer, throttle, brake };
    world.actControl(this.egoId!, { throttle, brake, steer }, reverse);
    return this.telemetry(steer, throttle, brake, reverse);
  }

  private telemetry(steer: number, throttle: number, brake: number, reverse: boolean): Json {
    const { world } = this.deps;
    const ego = world.actorState(this.egoId!);
    if (!ego) throw new Error('No active session');
    const egoPos = { x: ego.x, z: ego.z };

    const nearby: Json[] = [];
    const detections: Json[] = [];
    for (const state of world.presentActors()) {
      if (state.id === this.egoId) continue;
      const meta = world.meta.get(state.id);
      const kind = meta?.kind ?? 'car';
      const distance = planarDist(egoPos, state);
      if (kind !== 'pedestrian' && kind !== 'static_object' && distance <= 250) {
        nearby.push({
          id: state.id,
          pos: [Math.round(state.x * 100) / 100, Math.round(state.z * 100) / 100],
          yaw: Math.round(legacyYawDegFromSceneHeading(state.headingRad) * 10) / 10,
          type: meta?.category === 'dynamic' ? 'dynamic' : meta?.category === 'traffic' ? 'traffic' : 'other',
        });
      }
      // Truth-derived detections: every non-ego actor (see protocol doc).
      const heading = state.headingRad;
      detections.push({
        id: state.id,
        label: meta?.kind === 'static_object' ? 'prop' : (meta?.kind ?? 'car'),
        pos: [Math.round(state.x * 100) / 100, Math.round(state.z * 100) / 100, 0],
        distance: Math.round(distance * 100) / 100,
        velocity: [
          Math.round(state.speedMps * Math.cos(-heading) * 100) / 100,
          Math.round(state.speedMps * -Math.sin(-heading) * 100) / 100,
          0,
        ],
        speed_mps: Math.round(state.speedMps * 100) / 100,
        yaw: Math.round(legacyYawDegFromSceneHeading(heading) * 10) / 10,
      });
    }
    detections.sort((a, b) => Number(a['distance']) - Number(b['distance']));

    const dynamicActors = world
      .byCategory('dynamic')
      .filter(({ meta }) => meta.ownerSession === this.sessionId)
      .map(({ meta, state }) => this.serializeDynamicActor(meta.id, state.x, state.z, state.headingRad));

    const egoPose = { x: ego.x, z: ego.z, headingRad: ego.headingRad };
    const nowS = Date.now() / 1000;
    const alerts: V2xAlert[] = [
      ...evaProximityAlerts(world, egoPose, this.egoId!, this.deps.config.evaWarningDistanceM),
      ...evaYieldAlerts(world, egoPose, this.egoId!, this.deps.config.evaWarningDistanceM, this.inFrontSince, nowS),
      ...zoneAlerts(this.zones, world.frame, egoPos),
      ...geofenceAlerts(world, egoPos, this.egoId!),
    ];

    const out: Json = {
      type: 'telemetry',
      speed: Math.round(ego.speedMps * 3.6 * 10) / 10,
      gear: reverse ? -1 : 1,
      pos: [Math.round(ego.x * 100) / 100, Math.round(ego.z * 100) / 100, 0],
      rot: [0, Math.round(legacyYawDegFromSceneHeading(ego.headingRad) * 100) / 100, 0],
      steer: Math.round(steer * 1000) / 1000,
      throttle: Math.round(throttle * 1000) / 1000,
      brake: Math.round(brake * 1000) / 1000,
      nearby_actors: nearby,
      dynamic_actors: dynamicActors,
      detections,
    };
    if (alerts.length > 0) out['v2x_alerts'] = alerts;
    return out;
  }

  private async respawn(): Promise<Json> {
    this.requireActive();
    const { world } = this.deps;
    world.despawn(this.egoId!);
    const meta = { ownerSession: this.sessionId };
    let spawned: { ok: true; id: string } | { ok: false; error: string } = { ok: false, error: 'no spawn point' };
    for (let attempt = 0; attempt < 10 && !spawned.ok; attempt++) {
      spawned = world.spawnFreeform({ category: 'ego', kind: 'car', blueprint: 'vehicle.tesla.model3', pose: world.randomSpawnPoint(), meta });
    }
    if (!spawned.ok) throw new Error(`Respawn failed: ${spawned.error}`);
    this.egoId = spawned.id;
    await this.nextTick();
    const state = world.actorState(spawned.id);
    return {
      type: 'respawned',
      pos: state ? [Math.round(state.x * 100) / 100, Math.round(state.z * 100) / 100, 0] : [0, 0, 0],
      vehicle_id: spawned.id,
    };
  }

  private async teleport(msg: Json): Promise<Json> {
    const requestIdRaw = msg['request_id'];
    if (typeof requestIdRaw !== 'string' || requestIdRaw.trim() === '' || requestIdRaw.length > TELEPORT_REQUEST_ID_MAX_LENGTH) {
      return {
        type: 'teleport_error',
        success: false,
        request_id: typeof requestIdRaw === 'string' ? requestIdRaw.slice(0, TELEPORT_REQUEST_ID_MAX_LENGTH) : null,
        message: `teleport requires a non-empty string 'request_id' of at most ${TELEPORT_REQUEST_ID_MAX_LENGTH} characters`,
      };
    }
    const requestId = requestIdRaw;
    const fail = (message: string): Json => ({ type: 'teleport_error', success: false, request_id: requestId, message });
    try {
      this.requireActive();
      const { world } = this.deps;
      const finite = (value: unknown, name: string): number => {
        if (value === null || typeof value === 'boolean') throw new Error(`teleport requires finite numeric '${name}'`);
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`teleport requires finite numeric '${name}'`);
        return n;
      };
      const x = finite(msg['x'], 'x');
      const y = finite(msg['y'], 'y');
      if (Math.abs(x) > TELEPORT_COORD_ABS_LIMIT_M || Math.abs(y) > TELEPORT_COORD_ABS_LIMIT_M) {
        return fail('teleport coordinates exceed the world safety limit');
      }
      // Map envelope from lane extents ± margin (v1 used spawn-point extents).
      const envelope = this.laneEnvelope();
      if (
        x < envelope.minX - TELEPORT_MAP_MARGIN_M || x > envelope.maxX + TELEPORT_MAP_MARGIN_M ||
        y < envelope.minZ - TELEPORT_MAP_MARGIN_M || y > envelope.maxZ + TELEPORT_MAP_MARGIN_M
      ) {
        return fail('teleport coordinates are outside the active map envelope');
      }
      const nearest = world.bundle.graph.nearestLane({ x, y: -y }, { maxDistM: TELEPORT_MAX_ROAD_DISTANCE_M });
      if (!nearest) return fail('teleport target is too far from a road');

      let snappedToRoad = true;
      if (msg['z'] !== undefined && msg['z'] !== null) {
        const z = finite(msg['z'], 'z');
        if (z < TELEPORT_MIN_Z_M || z > TELEPORT_MAX_Z_M) {
          return fail(`teleport z must be between ${TELEPORT_MIN_Z_M} and ${TELEPORT_MAX_Z_M} metres`);
        }
        snappedToRoad = false;
      }
      const ego = world.actorState(this.egoId!);
      let yawDeg = ego ? legacyYawDegFromSceneHeading(ego.headingRad) : 0;
      if (msg['yaw'] !== undefined && msg['yaw'] !== null) {
        const yaw = finite(msg['yaw'], 'yaw');
        if (Math.abs(yaw) > TELEPORT_MAX_ABS_YAW_DEG) {
          return fail(`teleport yaw must be within +/-${TELEPORT_MAX_ABS_YAW_DEG} degrees`);
        }
        yawDeg = ((yaw + 180) % 360 + 360) % 360 - 180;
      }

      world.despawn(this.egoId!);
      const pose = world.poseFromLegacy(x, y, yawDeg);
      const spawned = world.spawnFreeform({
        category: 'ego',
        kind: 'car',
        blueprint: 'vehicle.tesla.model3',
        pose,
        meta: { ownerSession: this.sessionId },
      });
      if (!spawned.ok) return fail(`Teleport failed: ${spawned.error}`);
      this.egoId = spawned.id;
      await this.nextTick();
      const state = world.actorState(spawned.id);
      if (!state) return fail('Teleport did not confirm the requested pose');
      return {
        type: 'teleported',
        success: true,
        request_id: requestId,
        pos: [Math.round(state.x * 100) / 100, Math.round(state.z * 100) / 100, 0],
        yaw: Math.round(legacyYawDegFromSceneHeading(state.headingRad) * 100) / 100,
        snapped_to_road: snappedToRoad,
        vehicle_id: spawned.id,
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private laneEnvelope(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const graph = this.deps.world.bundle.graph;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const rsl of graph.laneRsls()) {
      const geom = graph.geometry(rsl);
      if (!geom) continue;
      for (const p of geom.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        const z = -p.y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    return { minX, maxX, minZ, maxZ };
  }

  /** Resolve after roughly one world tick (state visibility after spawns). */
  private nextTick(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, this.deps.world.dt * 1200);
    return promise;
  }

  private end(): Json {
    this.cleanup();
    return { type: 'session_ended' };
  }

  private cleanup(): void {
    const { world } = this.deps;
    if (this.egoId !== null) {
      world.despawn(this.egoId);
      this.egoId = null;
    }
    for (const list of [this.reconstructionIds, this.scenarioActorIds]) {
      for (const id of list) world.despawn(id);
      list.length = 0;
    }
    for (const placed of this.placedObjects) world.despawn(placed.actorId);
    this.placedObjects = [];
    for (const { meta } of world.byCategory('dynamic')) {
      if (meta.ownerSession === this.sessionId) world.despawn(meta.id);
    }
    this.inFrontSince.clear();
    this.active = false;
  }

  /* ------------------------------------------------------------ placement */

  private spawnObject(blueprint: string, forwardOffset: number): Json {
    this.requireActive();
    if (blueprint === '') throw new Error('spawn_object requires a blueprint');
    const { world } = this.deps;
    const ego = world.actorState(this.egoId!);
    if (!ego) throw new Error('No active session');
    const yawRad = -ego.headingRad; // legacy yaw in radians
    const pose = {
      x: ego.x + forwardOffset * Math.cos(yawRad),
      z: ego.z + forwardOffset * Math.sin(yawRad),
      headingRad: ego.headingRad,
    };
    const kind = kindForBlueprint(blueprint);
    const result = world.spawn({
      category: 'placed',
      kind,
      blueprint,
      spawn: {
        kind,
        pose,
        speedMps: 0,
        snapToLane: false,
        static: true,
        route: { kind: 'polyline', points: [{ x: pose.x, z: pose.z }] },
      },
      meta: { ownerSession: this.sessionId },
    });
    if (!result.ok) throw new Error(`Failed to spawn ${blueprint} — ${result.error}`);
    const pos: [number, number, number] = [Math.round(pose.x * 100) / 100, Math.round(pose.z * 100) / 100, 0];
    const yaw = Math.round(legacyYawDegFromSceneHeading(pose.headingRad) * 100) / 100;
    this.placedObjects.push({ actorId: result.id, blueprint, pos, yaw });
    return { type: 'object_spawned', actor_id: result.id, blueprint, pos, placed_count: this.placedObjects.length };
  }

  private undoPlace(): Json {
    this.requireActive();
    const entry = this.placedObjects.pop();
    if (!entry) return { type: 'undo_empty', message: 'No objects to undo' };
    this.deps.world.despawn(entry.actorId);
    return { type: 'object_removed', blueprint: entry.blueprint, pos: entry.pos, placed_count: this.placedObjects.length };
  }

  private spawnDynamicActor(blueprint: string, geofenceRadius: number, message: string): Json {
    this.requireActive();
    if (!blueprint.startsWith('vehicle.')) throw new Error('Dynamic actors must use vehicle blueprints');
    const kind = kindForBlueprint(blueprint);
    if (kind === 'motorcycle' || kind === 'bicycle') throw new Error('Dynamic actors must be four-wheeled vehicles');
    const { world } = this.deps;
    const radius = Math.max(5, Math.min(250, geofenceRadius));
    const name = displayNameFromBlueprint(blueprint);
    const geofenceMessage = message.trim() !== '' ? message.trim() : `${name} geofence active`;
    let result: { ok: true; id: string } | { ok: false; error: string } = { ok: false, error: 'no spawn point' };
    for (let attempt = 0; attempt < 10 && !result.ok; attempt++) {
      const point = world.randomSpawnPoint();
      result = world.spawn({
        category: 'dynamic',
        kind,
        blueprint,
        spawn: { kind, pose: point, speedMps: 0, snapToLane: true },
        meta: { name, geofenceRadiusM: radius, geofenceMessage, ownerSession: this.sessionId },
      });
    }
    if (!result.ok) throw new Error(`Failed to spawn ${blueprint} for autopilot: ${result.error}`);
    const state = world.actorState(result.id);
    return {
      type: 'dynamic_actor_spawned',
      actor: this.serializeDynamicActor(result.id, state?.x ?? 0, state?.z ?? 0, state?.headingRad ?? 0),
      count: world.byCategory('dynamic').filter(({ meta }) => meta.ownerSession === this.sessionId).length,
    };
  }

  private serializeDynamicActor(actorId: string, x: number, z: number, headingRad: number): Json {
    const meta = this.deps.world.meta.get(actorId);
    return {
      actor_id: actorId,
      blueprint: meta?.blueprint ?? '',
      name: meta?.name ?? '',
      pos: [Math.round(x * 100) / 100, Math.round(z * 100) / 100, 0],
      yaw: Math.round(legacyYawDegFromSceneHeading(headingRad) * 10) / 10,
      geofence_radius: meta?.geofenceRadiusM ?? 0,
      message: meta?.geofenceMessage ?? '',
      autopilot: true,
    };
  }

  private despawnDynamicActor(actorId: string): Json {
    this.requireActive();
    const { world } = this.deps;
    const mine = world.byCategory('dynamic').filter(({ meta }) => meta.ownerSession === this.sessionId);
    if (!mine.some(({ meta }) => meta.id === actorId)) {
      return { type: 'dynamic_actor_missing', actor_id: actorId, count: mine.length };
    }
    world.despawn(actorId);
    return { type: 'dynamic_actor_despawned', actor_id: actorId, count: mine.length - 1 };
  }

  private clearNonEgo(): Json {
    this.requireActive();
    const { world } = this.deps;
    let destroyed = 0;
    let preserved = 0;
    for (const state of world.presentActors()) {
      const meta = world.meta.get(state.id);
      if (meta?.category === 'ego') {
        preserved += 1;
        continue;
      }
      if (!meta || meta.kind === 'pedestrian' || meta.kind === 'static_object') continue;
      if (meta.category === 'ghost') continue; // twin mirror owns its actors
      if (world.despawn(state.id)) destroyed += 1;
    }
    this.placedObjects = this.placedObjects.filter((p) => world.actorState(p.actorId) !== undefined);
    return { type: 'non_ego_vehicles_cleared', destroyed, preserved, placed_count: this.placedObjects.length };
  }

  private syncZones(zones: V2xZone[]): Json {
    this.requireActive();
    this.zones = zones;
    let drawn = 0;
    for (const zone of zones) {
      if (!Array.isArray(zone.polygon) || zone.polygon.length < 3) continue;
      if ((zone.signal_type ?? 'warning') === 'info') continue;
      drawn += 1;
    }
    return { type: 'v2x_zones_synced', drawn };
  }

  private loadScenario(file: string): Json {
    this.requireActive();
    if (this.deps.scenarios.isTemplate(file)) {
      const result = this.deps.scenarios.instantiateTemplate(file, this.sessionId);
      this.scenarioActorIds.push(...result.spawned);
      return {
        type: 'scenario_loaded',
        name: result.name,
        file,
        zones: result.zones,
        spawned: result.spawned.length,
        failed: result.failed,
        failures: result.failures,
        placed_count: this.placedObjects.length,
      };
    }
    const placement = this.deps.scenarios.loadPlacement(file);
    let spawned = 0;
    let failed = 0;
    for (const obj of placement.objects) {
      const kind = kindForBlueprint(obj.blueprint);
      const pose = this.deps.world.poseFromLegacy(obj.pos[0], obj.pos[1], obj.yaw);
      const result = this.deps.world.spawn({
        category: 'placed',
        kind,
        blueprint: obj.blueprint,
        spawn: { kind, pose, speedMps: 0, snapToLane: false, static: true, route: { kind: 'polyline', points: [{ x: pose.x, z: pose.z }] } },
        meta: { ownerSession: this.sessionId },
      });
      if (result.ok) {
        this.placedObjects.push({ actorId: result.id, blueprint: obj.blueprint, pos: [...obj.pos] as [number, number, number], yaw: obj.yaw });
        spawned += 1;
      } else {
        failed += 1;
      }
    }
    return {
      type: 'scenario_loaded',
      name: placement.name,
      file,
      zones: placement.zones,
      spawned,
      failed,
      placed_count: this.placedObjects.length,
    };
  }

  private saveScenario(name: string, zones: unknown[]): Json {
    this.requireActive();
    const snapshot: PlacedObject[] = this.placedObjects.map((p) => ({ blueprint: p.blueprint, pos: p.pos, yaw: p.yaw }));
    if (snapshot.length === 0 && zones.length === 0) {
      return { type: 'error', message: 'Nothing to save — place objects or draw zones first' };
    }
    if (name.trim() === '') return { type: 'error', message: 'save_scenario requires a name' };
    const saved = this.deps.scenarios.savePlacement(name, snapshot, zones);
    return { type: 'scenario_saved', name, ...saved };
  }
}
