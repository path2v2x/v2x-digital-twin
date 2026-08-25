/**
 * Environment-based configuration. Names keep the spirit of the v1 bridge's
 * DTB_* variables but under a TWIN_ prefix; every default is local-only
 * (no AWS, no external polling) per the wave-2 constraints.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** apps/twin-server/ */
export const APP_ROOT = path.resolve(HERE, '..');
/** repo root (v2x-backend/) */
export const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric, got ${raw}`);
  return value;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['off', 'false', '0', 'no'].includes(raw.toLowerCase());
}

export interface TwinConfig {
  readonly wsPort: number;
  readonly httpPort: number;
  readonly mapBundleDir: string;
  readonly mapId: string;
  readonly camerasJson: string;
  readonly footageMp4: string;
  readonly tickDt: number;
  readonly horizonSeconds: number;
  readonly evaWarningDistanceM: number;
  /** twin_sync: local perception poller (1 s). Default OFF. */
  readonly syncLocal: boolean;
  readonly detectionsUrl: string;
  readonly localPollIntervalS: number;
  /** twin_sync: cloud detections poller (5 s). Default OFF. */
  readonly syncCloud: boolean;
  readonly cloudApiUrl: string;
  readonly cloudPollIntervalS: number;
  readonly cloudLimit: number;
  readonly cloudStaleSeconds: number;
  /** Recorded detections (JSON list) for replay + historical reconstruction. */
  readonly recordedDetections: string;
  readonly despawnAfterS: number;
  /** Publication (uplink port): local dir by default, S3 only when bucket set. */
  readonly publishDir: string;
  readonly publishStateIntervalS: number;
  readonly s3Bucket: string;
  readonly s3Region: string;
  readonly scenariosDir: string;
  readonly trajectoriesDir: string;
  readonly userScenariosDir: string;
  readonly userTrajectoriesDir: string;
  readonly trafficDir: string;
  readonly mjpegFps: number;
  /** Live KVS camera sourcing; disable with TWIN_LIVE_FEEDS=0. */
  readonly liveFeeds: boolean;
  readonly kvsStreamPrefix: string;
  readonly kvsRegion: string;
  readonly awsProfile: string;
}

export function loadConfig(): TwinConfig {
  return {
    wsPort: num('TWIN_WS_PORT', 8765),
    httpPort: num('TWIN_HTTP_PORT', 8090),
    mapBundleDir: str('TWIN_MAP_BUNDLE', '/home/path/simforge-assets/map-bundles/richmond-field-station'),
    mapId: 'richmond-field-station',
    camerasJson: str('TWIN_CAMERAS_JSON', path.join(REPO_ROOT, 'config', 'cameras.json')),
    footageMp4: str(
      'TWIN_FOOTAGE_MP4',
      path.join(REPO_ROOT, 'assets', 'richmond-field-station', 'map', 'richmond-field-station_20260410-185647.mp4'),
    ),
    tickDt: 0.05,
    horizonSeconds: num('TWIN_HORIZON_SECONDS', 4 * 3600),
    evaWarningDistanceM: num('TWIN_EVA_WARNING_DISTANCE_M', 20),
    syncLocal: flag('TWIN_SYNC_LOCAL', false),
    detectionsUrl: str('TWIN_DETECTIONS_URL', 'http://127.0.0.1:8090/detections/latest'),
    localPollIntervalS: num('TWIN_POLL_INTERVAL', 1),
    syncCloud: flag('TWIN_SYNC_CLOUD', false),
    cloudApiUrl: str('V2X_API_URL', 'https://w0j9m7dgpg.execute-api.us-west-1.amazonaws.com/detections/recent'),
    cloudPollIntervalS: num('V2X_POLL_INTERVAL', 5),
    cloudLimit: num('V2X_LIMIT', 50),
    cloudStaleSeconds: num('V2X_STALE_SECONDS', 300),
    recordedDetections: str('TWIN_RECORDED_DETECTIONS', path.join(APP_ROOT, 'assets', 'recorded', 'event1.json')),
    despawnAfterS: num('TWIN_DESPAWN_SECONDS', 12),
    publishDir: str('TWIN_PUBLISH_DIR', path.join(APP_ROOT, 'var', 'publication')),
    publishStateIntervalS: num('TWIN_PUBLISH_STATE_INTERVAL', 5),
    s3Bucket: str('TWIN_S3_BUCKET', ''),
    s3Region: str('TWIN_S3_REGION', 'us-west-1'),
    scenariosDir: str('TWIN_SCENARIOS_DIR', path.join(APP_ROOT, 'assets', 'scenarios')),
    trajectoriesDir: str('TWIN_TRAJECTORIES_DIR', path.join(APP_ROOT, 'assets', 'trajectories')),
    userScenariosDir: str('TWIN_USER_SCENARIOS_DIR', path.join(APP_ROOT, 'var', 'scenarios')),
    userTrajectoriesDir: str('TWIN_USER_TRAJECTORIES_DIR', path.join(APP_ROOT, 'var', 'trajectories')),
    trafficDir: str('TWIN_TRAFFIC_DIR', path.join(APP_ROOT, 'assets', 'traffic')),
    mjpegFps: num('TWIN_MJPEG_FPS', 10),
    liveFeeds: flag('TWIN_LIVE_FEEDS', true),
    kvsStreamPrefix: str('TWIN_KVS_STREAM_PREFIX', 'v2x-backend-cam-'),
    kvsRegion: str('TWIN_KVS_REGION', 'us-west-2'),
    awsProfile: str('TWIN_AWS_PROFILE', 'path'),
  };
}
