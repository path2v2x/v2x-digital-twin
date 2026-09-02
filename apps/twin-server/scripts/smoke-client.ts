/**
 * Scripted protocol client — boot proof + committed transcript evidence.
 * Exercises: /drive session lifecycle, keyboard driving, teleport, zones →
 * alerts, EVA scenario, traffic preset, trajectory playback, weather,
 * placement; /twin hello + twin_cameras + replay clock; truth_frame relay on
 * both paths; MJPEG endpoints. Writes a JSONL transcript to stdout.
 */
import WebSocket from 'ws';
import { TruthStreamClient, type TruthFrame } from '@simforge-oss/training-env';

const WS = process.env['TWIN_WS'] ?? 'ws://127.0.0.1:8765';
const HTTP = process.env['TWIN_HTTP'] ?? 'http://127.0.0.1:8090';

interface Transcript {
  send(direction: 'tx' | 'rx' | 'note', payload: unknown): void;
}

const transcript: Transcript = {
  send(direction, payload) {
    console.log(JSON.stringify({ at: new Date().toISOString(), [direction]: payload }));
  },
};

class Client {
  private readonly ws: WebSocket;
  private readonly pending: Array<(msg: Record<string, unknown>) => void> = [];
  readonly jsonMessages: Array<Record<string, unknown>> = [];
  readonly truth = new TruthStreamClient();
  readonly truthFrames: TruthFrame[] = [];
  rawTruthBytes = 0;

  constructor(path: string) {
    this.ws = new WebSocket(`${WS}${path}`);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const bytes = data as Buffer;
        this.rawTruthBytes += bytes.length;
        for (const frame of this.truth.push(new Uint8Array(bytes))) this.truthFrames.push(frame);
        return;
      }
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      this.jsonMessages.push(msg);
      const waiter = this.pending.shift();
      if (waiter) waiter(msg);
      else transcript.send('rx', msg);
    });
  }

  open(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.ws.once('open', resolve);
    this.ws.once('error', reject);
    return promise;
  }

  /** Send a request and await the next JSON reply (protocol is req/resp). */
  request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    transcript.send('tx', payload);
    this.pending.push((msg) => {
      transcript.send('rx', msg);
      resolve(msg);
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close(): void {
    this.ws.close();
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  transcript.send('note', `PASS ${label}`);
}

/* --------------------------------------------------------------- /drive */
const drive = new Client('/drive');
await drive.open();

const status = await drive.request({ type: 'server_status' });
assert(status['type'] === 'server_status', 'server_status round-trip');

const maps = await drive.request({ type: 'list_maps' });
assert(maps['current_map'] === 'richmond-field-station', 'list_maps names richmond-field-station');

const ready = await drive.request({
  type: 'start_session',
  start: '2026-04-10T18:56:00Z',
  end: '2026-04-10T19:00:00Z',
  vehicle: 'vehicle.tesla.model3',
});
assert(ready['type'] === 'session_ready', 'session_ready');
const vehicleId = String(ready['vehicle_id']);

// keyboard driving: full throttle 2 s, confirm speed rises and pos changes.
let telemetry: Record<string, unknown> = {};
const posBefore = [] as number[];
for (let i = 0; i < 20; i++) {
  telemetry = await drive.request({ type: 'control', s: 0, t: 1, b: 0 });
  if (i === 0) posBefore.push(...(telemetry['pos'] as number[]));
  await sleep(100);
}
assert(telemetry['type'] === 'telemetry', 'telemetry round-trip');
assert(Number(telemetry['speed']) > 5, `driving accelerates (speed=${telemetry['speed']} km/h after 2 s)`);
assert(Array.isArray(telemetry['detections']), 'telemetry.detections present');

// zones: draw a polygon around the ego's current position → zone alert.
const pos = telemetry['pos'] as number[];
// convert scene → wgs84 via the known flat-earth origin (contract doc)
const LAT0 = 37.9150891287087;
const LON0 = -122.333308830857;
const M_LAT = 111320;
const mLon = M_LAT * Math.cos((LAT0 * Math.PI) / 180);
const toLatLon = (x: number, z: number): [number, number] => [LON0 + x / mLon, LAT0 - z / M_LAT];
const [cx, cz] = [pos[0]!, pos[1]!];
const polygon = [
  toLatLon(cx - 30, cz - 30),
  toLatLon(cx + 30, cz - 30),
  toLatLon(cx + 30, cz + 30),
  toLatLon(cx - 30, cz + 30),
];
const zonesResp = await drive.request({
  type: 'sync_v2x_zones',
  zones: [{ id: 'smoke-zone', name: 'Smoke Zone', message: 'Smoke zone entered', zone_kind: 'polygon', signal_type: 'warning', polygon, color: '#f00' }],
});
assert(zonesResp['type'] === 'v2x_zones_synced' && zonesResp['drawn'] === 1, 'sync_v2x_zones drawn=1');
const zoneTelemetry = await drive.request({ type: 'control', s: 0, t: 0, b: 1 });
const zoneAlerts = (zoneTelemetry['v2x_alerts'] ?? []) as Array<Record<string, unknown>>;
assert(zoneAlerts.some((a) => a['id'] === 'zone:smoke-zone'), 'zone entry raises v2x_alert');

// scenario list + EVA firetruck template
const scenarioList = await drive.request({ type: 'list_scenarios' });
const scenarios = scenarioList['scenarios'] as Array<Record<string, unknown>>;
assert(scenarios.length >= 3, `scenario_list has ${scenarios.length} entries (>=3 templates)`);
const loaded = await drive.request({ type: 'load_scenario', file: 'firetruck-from-south.template.json' });
assert(loaded['type'] === 'scenario_loaded' && Number(loaded['spawned']) >= 1, 'firetruck template spawns');

// traffic preset
const traffic = await drive.request({ type: 'spawn_traffic', preset: 'light' });
assert(traffic['type'] === 'traffic_spawned' && Number(traffic['count']) > 0, `traffic light preset spawns ${traffic['count']}`);
const trafficOff = await drive.request({ type: 'despawn_traffic' });
assert(Number(trafficOff['count']) >= 1, 'despawn_traffic destroys');

// weather
const weather = await drive.request({ type: 'set_weather', params: { fog_density: 80, precipitation: 30 } });
const weatherParams = weather['params'] as Record<string, number>;
assert(weatherParams['fog_density'] === 25, 'weather clamped to safe limits (fog 80→25)');

// trajectory playback
const trajList = await drive.request({ type: 'list_trajectories' });
assert((trajList['trajectories'] as unknown[]).length >= 1, 'trajectory list has event1.json');
const trajStart = await drive.request({ type: 'start_trajectory', file: 'event1.json' });
assert(trajStart['type'] === 'trajectory_started', `trajectory started (${trajStart['waypoints']} wp, ${trajStart['duration']} s)`);
await sleep(1500);
const trajStatus = await drive.request({ type: 'trajectory_status' });
assert(trajStatus['active'] === true && Number(trajStatus['elapsed']) > 0.5, 'trajectory clock advances');
await drive.request({ type: 'stop_trajectory' });

// placement
const placed = await drive.request({ type: 'spawn_object', blueprint: 'static.prop.constructioncone', offset: 10 });
assert(placed['type'] === 'object_spawned', 'spawn_object');
const undo = await drive.request({ type: 'undo_place' });
assert(undo['type'] === 'object_removed', 'undo_place');

// teleport
const teleported = await drive.request({ type: 'teleport', request_id: 'smoke-1', x: cx + 40, y: cz + 40 });
assert(teleported['type'] === 'teleported' && teleported['success'] === true, 'teleport succeeds near road');
assert(typeof teleported['vehicle_id'] === 'string' && teleported['vehicle_id'] !== vehicleId, 'teleport reallocates vehicle_id');

// respawn
const respawned = await drive.request({ type: 'respawn' });
assert(respawned['type'] === 'respawned', 'respawn');

// truth frames flowed on /drive
await sleep(300);
assert(drive.truthFrames.length > 20, `truth_frame relay on /drive (${drive.truthFrames.length} frames)`);
const lastFrame = drive.truthFrames[drive.truthFrames.length - 1]!;
transcript.send('note', `last truth frame tick=${lastFrame.tick} actors=[${lastFrame.actors.map((a) => `${a.id}:${a.class}`).join(',')}]`);

const ended = await drive.request({ type: 'end_session' });
assert(ended['type'] === 'session_ended', 'end_session');
drive.close();

/* ---------------------------------------------------------------- /twin */
const twin = new Client('/twin?cam=ch2');
await twin.open();
await sleep(500);
const hello = twin.jsonMessages.find((m) => m['type'] === 'twin_hello');
assert(hello !== undefined && hello['camera_id'] === 'ch2', 'twin_hello with camera_id');
const twinCameras = twin.jsonMessages.find((m) => m['type'] === 'twin_cameras');
assert(twinCameras !== undefined, 'twin_cameras sent on connect');
const cams = (twinCameras!['cameras'] ?? []) as Array<Record<string, unknown>>;
assert(cams.length === 4 && cams.every((c) => typeof c['stream_url'] === 'string'), 'twin_cameras: 4 cameras with stream URLs');
assert(twinCameras!['xodrSha256'] === '80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643', 'twin_cameras pins xodrSha256');

const twinStatus = await twin.request({ type: 'twin_status' });
assert(twinStatus['type'] === 'twin_mode' && twinStatus['mode'] === 'live', 'twin_status → twin_mode live');

const replay = await twin.request({ type: 'twin_replay', start: new Date(Date.now() - 3600_000).toISOString(), speed: 2 });
assert(replay['type'] === 'twin_mode' && replay['mode'] === 'replay', 'twin_replay enters replay mode');
await sleep(1200);
const clock = twin.jsonMessages.filter((m) => m['type'] === 'twin_clock');
assert(clock.length >= 1, 'twin_clock ticks');
const live = await twin.request({ type: 'twin_live' });
assert(live['mode'] === 'live', 'twin_live returns to live');
await sleep(300);
assert(twin.truthFrames.length > 5, `truth_frame relay on /twin (${twin.truthFrames.length} frames)`);
twin.close();

/* ---------------------------------------------------------------- MJPEG */
for (const channel of ['ch1', 'ch2', 'ch3', 'ch4']) {
  const controller = new AbortController();
  const response = await fetch(`${HTTP}/streams/${channel}.mjpg`, { signal: controller.signal });
  assert(response.status === 200, `${channel} MJPEG 200`);
  assert((response.headers.get('content-type') ?? '').startsWith('multipart/x-mixed-replace'), `${channel} multipart content-type`);
  const reader = response.body!.getReader();
  let got = 0;
  while (got < 20_000) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value?.length ?? 0;
  }
  controller.abort();
  assert(got >= 20_000, `${channel} streams JPEG bytes (${got})`);
}

transcript.send('note', 'SMOKE OK — all assertions passed');
process.exit(0);
