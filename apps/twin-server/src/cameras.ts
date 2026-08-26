/**
 * twin_cameras — the 4 calibrated site cameras from config/cameras.json,
 * enriched with per-channel real-feed stream URLs and the map digest pin.
 */
import { readFileSync } from 'node:fs';
import type { TwinConfig } from './config.js';

interface CameraEntry {
  id: string;
  device_id?: string;
  stream?: string;
  height_m: number;
  pitch_deg: number;
  yaw_deg: number;
  heading_deg: number;
  intrinsics: Record<string, number>;
  twin_pose: Record<string, number>;
}

interface RigFile {
  map?: string;
  feature_id: string;
  feature_category?: string;
  label?: string;
}

interface CamerasFile {
  site: { name?: string; lat: number; lon: number } & Record<string, unknown>;
  rig?: RigFile;
  cameras: CameraEntry[];
}

/**
 * A camera rig anchored to a map `SignalFeature` (a traffic-light pole), matching
 * `PoleCameraRig` in `@simforge/maps`. One pole carries many channels: the Richmond
 * mast holds all four at 7 m, differing only in bearing and pitch.
 *
 * `headingDeg` is a compass bearing and folds the mount bearing (`heading_deg`) and
 * the camera's yaw within the rig (`yaw_deg`) into one number; the compass-to-scene
 * conversion belongs to the consumer. `streamUrl` is supplied here rather than in the
 * map bundle, because bundles are content-addressed and must never carry endpoints.
 */
export interface PoleCameraRigMessage {
  readonly featureId: string;
  readonly map: string | null;
  readonly label: string | null;
  readonly cameras: ReadonlyArray<{
    id: string;
    headingDeg: number;
    pitchDeg: number;
    mountHeightM: number;
    intrinsics: Record<string, number>;
    correction: { yawDeg: number; pitchDeg: number; heightM: number; forwardM: number };
    streamUrl: string;
    feedMode: string;
    label: string | null;
  }>;
}

export interface TwinCamerasMessage {
  readonly type: 'twin_cameras';
  readonly mapId: string;
  readonly xodrSha256: string;
  readonly site: { lat: number; lon: number; name: string };
  readonly cameras: Array<CameraEntry & { stream_url: string; feed_mode: string }>;
  readonly rigs: readonly PoleCameraRigMessage[];
}

export function buildTwinCameras(config: TwinConfig, xodrSha256: string, host = 'localhost', feedModes: Record<string, string> = {}): TwinCamerasMessage {
  const parsed = JSON.parse(readFileSync(config.camerasJson, 'utf8')) as CamerasFile;
  const streamUrl = (id: string) => `http://${host}:${config.httpPort}/streams/${id}.mjpg`;
  const feedMode = (id: string) => feedModes[id] ?? 'replay';
  return {
    type: 'twin_cameras',
    mapId: config.mapId,
    xodrSha256,
    site: { lat: parsed.site.lat, lon: parsed.site.lon, name: String(parsed.site.name ?? '') },
    cameras: parsed.cameras.map((camera) => ({
      ...camera,
      stream_url: streamUrl(camera.id),
      feed_mode: feedMode(camera.id),
    })),
    rigs: buildRigs(parsed, streamUrl, feedMode),
  };
}

function buildRigs(
  parsed: CamerasFile,
  streamUrl: (id: string) => string,
  feedMode: (id: string) => string,
): readonly PoleCameraRigMessage[] {
  const rig = parsed.rig;
  if (!rig?.feature_id) return [];
  return [
    {
      featureId: rig.feature_id,
      map: rig.map ?? null,
      label: rig.label ?? null,
      cameras: parsed.cameras.map((camera) => ({
        id: camera.id,
        headingDeg: camera.heading_deg + camera.yaw_deg,
        pitchDeg: camera.pitch_deg,
        mountHeightM: camera.height_m,
        intrinsics: camera.intrinsics,
        correction: {
          yawDeg: camera.twin_pose.yaw_offset_deg ?? 0,
          pitchDeg: camera.twin_pose.pitch_offset_deg ?? 0,
          heightM: camera.twin_pose.height_offset_m ?? 0,
          forwardM: camera.twin_pose.forward_offset_m ?? 0,
        },
        streamUrl: streamUrl(camera.id),
        feedMode: feedMode(camera.id),
        label: camera.device_id ?? null,
      })),
    },
  ];
}
