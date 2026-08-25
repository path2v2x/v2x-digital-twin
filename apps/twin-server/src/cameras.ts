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

interface CamerasFile {
  site: { name?: string; lat: number; lon: number } & Record<string, unknown>;
  cameras: CameraEntry[];
}

export interface TwinCamerasMessage {
  readonly type: 'twin_cameras';
  readonly mapId: string;
  readonly xodrSha256: string;
  readonly site: { lat: number; lon: number; name: string };
  readonly cameras: Array<CameraEntry & { stream_url: string }>;
}

export function buildTwinCameras(config: TwinConfig, xodrSha256: string, host = 'localhost'): TwinCamerasMessage {
  const parsed = JSON.parse(readFileSync(config.camerasJson, 'utf8')) as CamerasFile;
  return {
    type: 'twin_cameras',
    mapId: config.mapId,
    xodrSha256,
    site: { lat: parsed.site.lat, lon: parsed.site.lon, name: String(parsed.site.name ?? '') },
    cameras: parsed.cameras.map((camera) => ({
      ...camera,
      stream_url: `http://${host}:${config.httpPort}/streams/${camera.id}.mjpg`,
    })),
  };
}
