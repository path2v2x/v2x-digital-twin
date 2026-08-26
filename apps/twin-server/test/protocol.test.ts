/**
 * Round-trip coverage for EVERY preserved protocol message type against a
 * live server (test ports). Integration test: the real 20 Hz loop, WS layer
 * and ffmpeg MJPEG service are the objects under test, so real time passes
 * here by design.
 *
 * /drive request types covered (34):
 *   server_status list_maps set_map list_vehicles list_objects start_session
 *   control respawn teleport(+teleport_error) end_session camera_switch
 *   set_camera_settings set_weather spawn_traffic despawn_traffic
 *   clear_non_ego_vehicles sync_v2x_zones spawn_object undo_place
 *   spawn_dynamic_actor despawn_dynamic_actor despawn_dynamic_actors
 *   list_scenarios load_scenario save_scenario delete_scenario
 *   list_xosc_scenarios start_xosc_scenario stop_xosc_scenario
 *   list_trajectories upload_trajectory start_trajectory stop_trajectory
 *   trajectory_status
 * /twin request types covered (3): twin_replay twin_live twin_status
 * /twin server-initiated covered (5): twin_hello twin_cameras twin_mode
 *   twin_clock twin_error
 * Binary: truth_frame on both paths. HTTP: /streams/ch1..4.mjpg, /health.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { TruthStreamClient, type TruthFrame } from '@simforge/training-env';
import { ScenarioStore } from '../src/scenarios.js';
import { startServers, type TwinServers } from '../src/server.js';
import { TrafficController } from '../src/traffic.js';
import { TrajectoryPlayer } from '../src/trajectory.js';
import { TwinSync } from '../src/twinsync.js';
import { TwinWorld } from '../src/world.js';
import { wgs84FromScene } from '../src/geo.js';
import { testConfig, sleep } from './helpers.js';

const config = testConfig();
let world: TwinWorld;
let servers: TwinServers;

type Json = Record<string, unknown>;

class WsClient {
  readonly ws: WebSocket;
  readonly json: Json[] = [];
  readonly truth = new TruthStreamClient();
  readonly frames: TruthFrame[] = [];
  private readonly pending: Array<(msg: Json) => void> = [];

  constructor(path: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${config.wsPort}${path}`);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        for (const frame of this.truth.push(new Uint8Array(data as Buffer))) this.frames.push(frame);
        return;
      }
      const msg = JSON.parse(data.toString()) as Json;
      this.json.push(msg);
      this.pending.shift()?.(msg);
    });
  }

  open(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.ws.once('open', resolve);
    this.ws.once('error', reject);
    return promise;
  }

  request(payload: Json): Promise<Json> {
    const { promise, resolve } = Promise.withResolvers<Json>();
    this.pending.push(resolve);
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  world = await TwinWorld.create(config);
  const sync = new TwinSync(world, config);
  const traffic = new TrafficController(world, config);
  const trajectories = new TrajectoryPlayer(world, config);
  const scenarios = new ScenarioStore(world, config);
  world.start();
  servers = startServers({ world, config, sync, traffic, trajectories, scenarios });
  await sleep(300);
});

afterAll(async () => {
  world.stop();
  await servers.close();
});

describe('/drive round-trips (every preserved message type)', () => {
  it('covers the full v1 dispatch table', async () => {
    const drive = new WsClient('/drive');
    await drive.open();
    const covered: string[] = [];
    const roundTrip = async (payload: Json, expectType: string): Promise<Json> => {
      const reply = await drive.request(payload);
      expect(reply['type'], `${String(payload['type'])} → ${expectType}`).toBe(expectType);
      covered.push(String(payload['type']));
      return reply;
    };

    await roundTrip({ type: 'server_status' }, 'server_status');
    const maps = await roundTrip({ type: 'list_maps' }, 'map_status');
    expect(maps['current_map']).toBe('richmond-field-station');
    expect(maps['xodrSha256']).toBe('80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643');
    await roundTrip({ type: 'set_map', map: 'richmond-field-station' }, 'map_set');
    const vehicles = await roundTrip({ type: 'list_vehicles' }, 'vehicle_list');
    expect((vehicles['vehicles'] as Json[]).length).toBeGreaterThanOrEqual(5);
    await roundTrip({ type: 'list_objects' }, 'object_list');

    const ready = await roundTrip(
      { type: 'start_session', start: '2026-04-12T05:25:00Z', end: '2026-04-12T05:27:00Z', vehicle: 'vehicle.tesla.model3' },
      'session_ready',
    );
    expect(typeof ready['vehicle_id']).toBe('string');
    // Historical reconstruction from the shipped recorded detections window.
    expect(Number(ready['objects_count'])).toBeGreaterThan(0);

    // Driving: hold full throttle 1.5 s → speed must rise (one-tick control).
    let telemetry: Json = {};
    for (let i = 0; i < 15; i++) {
      telemetry = await drive.request({ type: 'control', s: 0, t: 1, b: 0 });
      await sleep(90);
    }
    covered.push('control');
    expect(telemetry['type']).toBe('telemetry');
    expect(Number(telemetry['speed'])).toBeGreaterThan(3);
    expect(Array.isArray(telemetry['detections'])).toBe(true);
    expect(Array.isArray(telemetry['nearby_actors'])).toBe(true);

    await roundTrip({ type: 'camera_switch', view: 'hood' }, 'camera_switched');
    await roundTrip({ type: 'set_camera_settings', params: { fov: 100 } }, 'camera_settings_set');
    const weather = await roundTrip({ type: 'set_weather', params: { fog_density: 90 } }, 'weather_set');
    expect((weather['params'] as Json)['fog_density']).toBe(25);

    const traffic = await roundTrip({ type: 'spawn_traffic', preset: 'light' }, 'traffic_spawned');
    expect(Number(traffic['count'])).toBeGreaterThan(0);
    const trafficOff = await roundTrip({ type: 'despawn_traffic' }, 'traffic_despawned');
    expect(Number(trafficOff['count'])).toBeGreaterThanOrEqual(1);

    const pos = telemetry['pos'] as number[];
    const gps = wgs84FromScene(world.frame, { x: pos[0]!, z: pos[1]! });
    const zones = await roundTrip(
      {
        type: 'sync_v2x_zones',
        zones: [
          {
            id: 7,
            name: 'RT zone',
            message: 'RT zone entered',
            zone_kind: 'polygon',
            signal_type: 'warning',
            polygon: [
              [gps.lon - 0.0005, gps.lat - 0.0005],
              [gps.lon + 0.0005, gps.lat - 0.0005],
              [gps.lon + 0.0005, gps.lat + 0.0005],
              [gps.lon - 0.0005, gps.lat + 0.0005],
            ],
            color: '#ff0000',
          },
        ],
      },
      'v2x_zones_synced',
    );
    expect(zones['drawn']).toBe(1);
    const zoneTelemetry = await drive.request({ type: 'control', s: 0, t: 0, b: 1 });
    const alerts = (zoneTelemetry['v2x_alerts'] ?? []) as Json[];
    expect(alerts.some((a) => a['id'] === 'zone:7')).toBe(true);

    const placed = await roundTrip({ type: 'spawn_object', blueprint: 'static.prop.constructioncone', offset: 12 }, 'object_spawned');
    expect(Number(placed['placed_count'])).toBe(1);
    await roundTrip({ type: 'undo_place' }, 'object_removed');
    const undoEmpty = await drive.request({ type: 'undo_place' });
    expect(undoEmpty['type']).toBe('undo_empty');

    const dyn = await roundTrip({ type: 'spawn_dynamic_actor', blueprint: 'vehicle.nissan.patrol', geofence_radius: 40, message: 'watch out' }, 'dynamic_actor_spawned');
    const dynId = String((dyn['actor'] as Json)['actor_id']);
    const dynGone = await roundTrip({ type: 'despawn_dynamic_actor', actor_id: dynId }, 'dynamic_actor_despawned');
    expect(dynGone['actor_id']).toBe(dynId);
    await roundTrip({ type: 'spawn_dynamic_actor', blueprint: 'vehicle.dodge.charger' }, 'dynamic_actor_spawned');
    const dynAll = await roundTrip({ type: 'despawn_dynamic_actors' }, 'dynamic_actors_despawned');
    expect(Number(dynAll['count'])).toBe(1);

    const scenarioList = await roundTrip({ type: 'list_scenarios' }, 'scenario_list');
    const templates = (scenarioList['scenarios'] as Json[]).filter((s) => s['kind'] === 'template');
    expect(templates.length).toBe(3);
    const loaded = await roundTrip({ type: 'load_scenario', file: 'firetruck-from-south.template.json' }, 'scenario_loaded');
    expect(Number(loaded['spawned'])).toBeGreaterThanOrEqual(1);

    await roundTrip({ type: 'spawn_object', blueprint: 'static.prop.box', offset: 15 }, 'object_spawned');
    const saved = await roundTrip({ type: 'save_scenario', name: 'RT saved', zones: [] }, 'scenario_saved');
    const savedFile = String(saved['file']);
    // Remove the live box first: reloading spawns at the recorded pose, and
    // the engine rejects overlapping footprints (v1 CARLA behaved likewise).
    await roundTrip({ type: 'undo_place' }, 'object_removed');
    const reloaded = await roundTrip({ type: 'load_scenario', file: savedFile }, 'scenario_loaded');
    expect(Number(reloaded['spawned'])).toBe(1);
    await roundTrip({ type: 'delete_scenario', file: savedFile }, 'scenario_deleted');

    await roundTrip({ type: 'list_xosc_scenarios' }, 'xosc_list');
    const xoscStart = await drive.request({ type: 'start_xosc_scenario', file: 'x.xosc' });
    expect(xoscStart['type']).toBe('error');
    covered.push('start_xosc_scenario');
    const xoscStop = await drive.request({ type: 'stop_xosc_scenario' });
    expect(xoscStop['type']).toBe('error');
    covered.push('stop_xosc_scenario');

    const clearResult = await roundTrip({ type: 'clear_non_ego_vehicles' }, 'non_ego_vehicles_cleared');
    expect(Number(clearResult['preserved'])).toBeGreaterThanOrEqual(1);

    const trajectoryList = await roundTrip({ type: 'list_trajectories' }, 'trajectory_list');
    expect((trajectoryList['trajectories'] as Json[]).length).toBeGreaterThanOrEqual(1);
    const a = wgs84FromScene(world.frame, { x: 300, z: 300 });
    const b = wgs84FromScene(world.frame, { x: 310, z: 300 });
    await roundTrip(
      { type: 'upload_trajectory', name: 'rt-upload', data: [{ t: 0, lat: a.lat, lon: a.lon }, { t: 2, lat: b.lat, lon: b.lon }] },
      'trajectory_uploaded',
    );
    const trajectoryStarted = await roundTrip({ type: 'start_trajectory', file: 'rt-upload.json' }, 'trajectory_started');
    expect(Number(trajectoryStarted['waypoints'])).toBe(2);
    const trajectoryStatus = await roundTrip({ type: 'trajectory_status' }, 'trajectory_status');
    expect(trajectoryStatus['active']).toBe(true);
    const trajectoryStopped = await roundTrip({ type: 'stop_trajectory' }, 'trajectory_stopped');
    expect(trajectoryStopped['stopped']).toBe(true);

    // teleport: happy path + error path
    const teleported = await roundTrip({ type: 'teleport', request_id: 'rt-1', x: pos[0]! + 30, y: pos[1]! }, 'teleported');
    expect(teleported['success']).toBe(true);
    const teleportError = await drive.request({ type: 'teleport', request_id: 'rt-2', x: 99_999, y: 99_999 });
    expect(teleportError['type']).toBe('teleport_error');
    covered.push('teleport_error');

    const respawned = await roundTrip({ type: 'respawn' }, 'respawned');
    expect(typeof respawned['vehicle_id']).toBe('string');

    // binary relay flowed throughout
    await sleep(300);
    expect(drive.frames.length).toBeGreaterThan(20);

    await roundTrip({ type: 'end_session' }, 'session_ended');
    const unknown = await drive.request({ type: 'definitely_not_a_message' });
    expect(unknown['type']).toBe('error');

    drive.close();
    // 34 preserved /drive requests + teleport_error variant
    expect(new Set(covered).size).toBeGreaterThanOrEqual(35);
  });
});

describe('/twin round-trips', () => {
  it('hello, cameras, status, replay, clock, live, errors, truth relay', async () => {
    const twin = new WsClient('/twin?cam=ch3');
    await twin.open();
    await sleep(200);
    const hello = twin.json.find((m) => m['type'] === 'twin_hello');
    expect(hello).toBeDefined();
    expect(hello!['camera_id']).toBe('ch3');
    expect(hello!['cameras']).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);

    const cameras = twin.json.find((m) => m['type'] === 'twin_cameras');
    expect(cameras).toBeDefined();
    const cameraList = cameras!['cameras'] as Json[];
    expect(cameraList).toHaveLength(4);
    expect(cameraList.map((c) => c['id'])).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
    for (const camera of cameraList) {
      expect(String(camera['stream_url'])).toMatch(new RegExp(`:${config.httpPort}/streams/ch\\d\\.mjpg$`));
      expect((camera['intrinsics'] as Json)['fx']).toBe(1325.4);
    }
    expect((cameras!['site'] as Json)['lat']).toBe(37.91560117034595);

    const status = await twin.request({ type: 'twin_status' });
    expect(status['type']).toBe('twin_mode');
    expect(status['mode']).toBe('live');
    expect(Array.isArray(status['objects'])).toBe(true);

    const replay = await twin.request({ type: 'twin_replay', start: new Date(Date.now() - 600_000).toISOString(), speed: 2 });
    expect(replay['type']).toBe('twin_mode');
    expect(replay['mode']).toBe('replay');
    expect(typeof replay['replay_clock']).toBe('string');

    const badReplay = await twin.request({ type: 'twin_replay', start: 'not-a-date' });
    expect(badReplay['type']).toBe('twin_error');

    await sleep(1100);
    expect(twin.json.some((m) => m['type'] === 'twin_clock')).toBe(true);

    const live = await twin.request({ type: 'twin_live' });
    expect(live['mode']).toBe('live');

    const unknown = await twin.request({ type: 'nonsense' });
    expect(unknown['type']).toBe('twin_error');

    expect(twin.frames.length).toBeGreaterThan(5);
    twin.close();
  });
});

describe('HTTP :8090', () => {
  it('serves multipart MJPEG with JPEG frames on all four channels', async () => {
    for (const channel of ['ch1', 'ch2', 'ch3', 'ch4']) {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${config.httpPort}/streams/${channel}.mjpg`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('multipart/x-mixed-replace');
      const reader = response.body!.getReader();
      let collected = Buffer.alloc(0);
      while (collected.length < 40_000) {
        const { value, done } = await reader.read();
        if (done) break;
        collected = Buffer.concat([collected, Buffer.from(value!)]);
      }
      controller.abort();
      expect(collected.includes('--frame')).toBe(true);
      expect(collected.includes(Buffer.from([0xff, 0xd8]))).toBe(true); // JPEG SOI
      expect(collected.includes('Content-Type: image/jpeg')).toBe(true);
    }
    const health = await fetch(`http://127.0.0.1:${config.httpPort}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Json;
    expect(body['status']).toBe('ok');
    const missing = await fetch(`http://127.0.0.1:${config.httpPort}/streams/ch9.mjpg`);
    expect(missing.status).toBe(404);
  });
});
