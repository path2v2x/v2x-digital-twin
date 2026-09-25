import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '..');
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
  /** Engine session age at which the world is re-rooted onto a fresh session. */
  readonly sessionEpochSeconds: number;
  readonly evaWarningDistanceM: number;
  readonly syncLocal: boolean;
  readonly detectionsUrl: string;
  readonly pollHz: number;
  readonly historyDb: string;
  readonly historyRetentionHours: number;
  readonly publicHttpOrigin: string;
  readonly archiveUrlTemplate: string;
  /** Recorded-segment listing (MediaMTX /list); `{channel}`, `{start}`, `{end}` are client-substituted. */
  readonly archiveListUrlTemplate: string;
  readonly archiveOffsetSeconds: number;
  readonly despawnAfterS: number;
  readonly publishDir: string;
  readonly publishStateIntervalS: number;
  readonly scenariosDir: string;
  readonly trajectoriesDir: string;
  readonly userScenariosDir: string;
  readonly userTrajectoriesDir: string;
  readonly trafficDir: string;
  readonly mjpegFps: number;
  readonly liveFeeds: boolean;
  readonly cameraUrlTemplate: string;
  /** When set, live camera frames are read from co-perception's broadcast socket instead of RTSP. */
  readonly cameraSocketPath: string;
}

export function loadConfig(): TwinConfig {
  return {
    wsPort: num('TWIN_WS_PORT', 8765),
    httpPort: num('TWIN_HTTP_PORT', 8090),
    mapBundleDir: str('TWIN_MAP_BUNDLE', path.join(REPO_ROOT, 'assets', 'richmond-field-station', 'bundle')),
    mapId: 'richmond-field-station',
    camerasJson: str('TWIN_CAMERAS_JSON', path.join(REPO_ROOT, 'config', 'cameras.json')),
    footageMp4: str(
      'TWIN_FOOTAGE_MP4',
      path.join(REPO_ROOT, 'assets', 'richmond-field-station', 'map', 'richmond-field-station_20260410-185647.mp4'),
    ),
    tickDt: 0.05,
    sessionEpochSeconds: num('TWIN_SESSION_EPOCH_SECONDS', 600),
    evaWarningDistanceM: num('TWIN_EVA_WARNING_DISTANCE_M', 20),
    syncLocal: flag('TWIN_SYNC_LOCAL', false),
    detectionsUrl: str('TWIN_DETECTIONS_URL', 'http://127.0.0.1:8091/detections/latest'),
    pollHz: num('TWIN_POLL_HZ', 10),
    historyDb: str('TWIN_HISTORY_DB', '/var/lib/v2x-twin/detections.sqlite'),
    historyRetentionHours: num('TWIN_HISTORY_RETENTION_HOURS', 72),
    publicHttpOrigin: str('TWIN_PUBLIC_HTTP_ORIGIN', ''),
    archiveUrlTemplate: str('TWIN_ARCHIVE_URL_TEMPLATE', ''),
    archiveListUrlTemplate: str('TWIN_ARCHIVE_LIST_URL_TEMPLATE', ''),
    archiveOffsetSeconds: num('TWIN_ARCHIVE_OFFSET_SECONDS', 0),
    despawnAfterS: num('TWIN_DESPAWN_SECONDS', 12),
    publishDir: str('TWIN_PUBLISH_DIR', path.join(APP_ROOT, 'var', 'publication')),
    publishStateIntervalS: num('TWIN_PUBLISH_STATE_INTERVAL', 5),
    scenariosDir: str('TWIN_SCENARIOS_DIR', path.join(APP_ROOT, 'assets', 'scenarios')),
    trajectoriesDir: str('TWIN_TRAJECTORIES_DIR', path.join(APP_ROOT, 'assets', 'trajectories')),
    userScenariosDir: str('TWIN_USER_SCENARIOS_DIR', path.join(APP_ROOT, 'var', 'scenarios')),
    userTrajectoriesDir: str('TWIN_USER_TRAJECTORIES_DIR', path.join(APP_ROOT, 'var', 'trajectories')),
    trafficDir: str('TWIN_TRAFFIC_DIR', path.join(APP_ROOT, 'assets', 'traffic')),
    mjpegFps: num('TWIN_MJPEG_FPS', 10),
    liveFeeds: flag('TWIN_LIVE_FEEDS', true),
    cameraUrlTemplate: str('TWIN_CAMERA_URL_TEMPLATE', 'rtsp://127.0.0.1:8554/{channel}'),
    cameraSocketPath: str('TWIN_CAMERA_SOCKET_PATH', ''),
  };
}
