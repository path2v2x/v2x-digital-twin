/**
 * Publication (uplink.py + map_data.py port). Default target is the local
 * filesystem; S3 is used ONLY when TWIN_S3_BUCKET is explicitly set.
 *
 * Layout mirrors the v1 S3 keys:
 *   api/state.json            {objects, map, timestamp}   every 5 s
 *   api/map-data.json         {geo_ref, road_network}     hourly
 *   map_data/road_network.json  same payload at the v1 export key
 *
 * Per-object snapshot JPEGs (snapshots/{id}/latest.jpg) are OUT OF SCOPE in
 * v2 — the server renders no pixels; state objects publish snapshot_url null.
 *
 * Road network: v1 extracted CARLA road edges as GPS polylines. v2 walks the
 * bundle's lane polylines and converts through the legacy flat-earth inverse,
 * preserving the [[ [lat, lon], ... ], ...] shape (v1 emitted [lat, lon]
 * pairs via carla_to_gps).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TwinConfig } from './config.js';
import { wgs84FromScene } from './geo.js';
import { parseUtcEpoch } from './ghosts.js';
import type { TwinSync } from './twinsync.js';
import type { TwinWorld } from './world.js';

const STATE_OBJECT_MAX_AGE_S = 30;

export class Publisher {
  private readonly world: TwinWorld;
  private readonly sync: TwinSync;
  private readonly config: TwinConfig;
  private timers: NodeJS.Timeout[] = [];

  constructor(world: TwinWorld, sync: TwinSync, config: TwinConfig) {
    this.world = world;
    this.sync = sync;
    this.config = config;
  }

  start(): void {
    this.publishMapData();
    this.publishState();
    this.timers.push(setInterval(() => this.publishState(), this.config.publishStateIntervalS * 1000));
    this.timers.push(setInterval(() => this.publishMapData(), 3600 * 1000));
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private write(relative: string, payload: unknown): void {
    const target = path.join(this.config.publishDir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(payload, null, 2));
    if (this.config.s3Bucket !== '') {
      // S3 writes are opt-in only. Uploading requires AWS credentials and the
      // aws CLI/SDK; deliberately not bundled — the deployment that sets
      // TWIN_S3_BUCKET must also mount a sync job for var/publication.
      console.warn('[publication] TWIN_S3_BUCKET is set but v2 ships local-only publication; sync var/publication externally.');
    }
  }

  /** v1 build_state_snapshot: fresh registry objects + bridge status. */
  publishState(): void {
    const nowS = Date.now() / 1000;
    const objects: Array<Record<string, unknown>> = [];
    for (const track of this.sync.mirror.tracks.values()) {
      const record = track.record;
      const producerEpoch = parseUtcEpoch(record.timestamp_utc);
      const age = producerEpoch !== null ? nowS - producerEpoch : nowS - track.lastSeen;
      if (age > STATE_OBJECT_MAX_AGE_S) continue;
      const state = track.actorId ? this.world.actorState(track.actorId) : undefined;
      const gps = state ? wgs84FromScene(this.world.frame, { x: state.x, z: state.z }) : null;
      objects.push({
        object_id: track.objectId,
        object_type: track.objectType,
        lat: record.gps_location?.latitude ?? gps?.lat ?? null,
        lon: record.gps_location?.longitude ?? gps?.lon ?? null,
        confidence: record.confidence ?? record.confidence_score ?? null,
        street_name: record.street_name ?? null,
        timestamp_utc: record.timestamp_utc ?? null,
        snapshot_url: null,
        snapshot_timestamp: null,
        last_updated: producerEpoch !== null ? Math.round(producerEpoch * 1000) : 0,
      });
    }
    this.write('api/state.json', {
      objects,
      map: {
        status: 'connected',
        engine: 'simforge',
        objects_tracked: objects.length,
        state_source: this.sync.currentMode() === 'replay' ? 'recorded_replay' : 'twin_sync',
        last_heartbeat: new Date(nowS * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      },
      timestamp: new Date(nowS * 1000).toISOString(),
    });
  }

  publishMapData(): void {
    const graph = this.world.bundle.graph;
    const roadNetwork: number[][][] = [];
    for (const rsl of graph.laneRsls()) {
      const geom = graph.geometry(rsl);
      if (!geom || geom.lane.laneType !== 'driving') continue;
      const line: number[][] = [];
      const step = Math.max(1, Math.floor(geom.points.length / 64));
      for (let i = 0; i < geom.points.length; i += step) {
        const p = geom.points[i]!;
        const gps = wgs84FromScene(this.world.frame, { x: p.x, z: -p.y });
        line.push([gps.lat, gps.lon]);
      }
      const last = geom.points[geom.points.length - 1]!;
      const gpsLast = wgs84FromScene(this.world.frame, { x: last.x, z: -last.y });
      line.push([gpsLast.lat, gpsLast.lon]);
      if (line.length >= 2) roadNetwork.push(line);
    }
    const payload = {
      geo_ref: {
        map_name: this.config.mapId,
        xodr_sha256: this.world.xodrSha256,
        origin_lat: this.world.frame.lat0,
        origin_lon: this.world.frame.lon0,
        projection: 'legacy-flat-earth (equirectangular around the XODR natural origin)',
      },
      road_network: roadNetwork,
    };
    this.write('api/map-data.json', payload);
    this.write('map_data/road_network.json', payload);
  }
}
