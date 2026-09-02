import type { CityViewer } from '@simforge-oss/viewer';
import { MathUtils, Vector3 } from 'three';
import { wgs84ToLegacy } from './coordinates';

export interface TwinCamera {
  id: 'ch1' | 'ch2' | 'ch3' | 'ch4';
  height_m: number;
  pitch_deg: number;
  yaw_deg: number;
  heading_deg: number;
  intrinsics: { fx: number; fy: number; cx: number; cy: number; width: number; height: number };
  twin_pose: { yaw_offset_deg: number; pitch_offset_deg: number; height_offset_m: number; forward_offset_m: number };
  streamUrl: string;
  feedMode?: 'live' | 'replay' | 'starting';
}

export const CAMERA_SITE = { lat: 37.91560117034595, lon: -122.33478756387032 };
const INTRINSICS = { fx: 1325.4, fy: 1325.4, cx: 1280, cy: 960, width: 2560, height: 1920 };
const FEED_BASE = import.meta.env.VITE_STREAM_BASE_URL ?? '';
export const CAMERAS: readonly TwinCamera[] = [
  { id: 'ch1', height_m: 7, pitch_deg: -39.2, yaw_deg: -46.06, heading_deg: 200, intrinsics: INTRINSICS, twin_pose: { yaw_offset_deg: 0, pitch_offset_deg: 0, height_offset_m: 0, forward_offset_m: .5 }, streamUrl: `${FEED_BASE}/streams/ch1.mjpg` },
  { id: 'ch2', height_m: 7, pitch_deg: -40.52, yaw_deg: 71.25, heading_deg: 300, intrinsics: INTRINSICS, twin_pose: { yaw_offset_deg: 5.74, pitch_offset_deg: 15.49, height_offset_m: 1.48, forward_offset_m: .5 }, streamUrl: `${FEED_BASE}/streams/ch2.mjpg` },
  { id: 'ch3', height_m: 7, pitch_deg: -30.42, yaw_deg: 14.58, heading_deg: 315, intrinsics: INTRINSICS, twin_pose: { yaw_offset_deg: .08, pitch_offset_deg: .26, height_offset_m: -.04, forward_offset_m: 1.5 }, streamUrl: `${FEED_BASE}/streams/ch3.mjpg` },
  { id: 'ch4', height_m: 7, pitch_deg: -43.48, yaw_deg: -22.63, heading_deg: 260, intrinsics: INTRINSICS, twin_pose: { yaw_offset_deg: -2.16, pitch_offset_deg: 4.95, height_offset_m: -.61, forward_offset_m: .5 }, streamUrl: `${FEED_BASE}/streams/ch4.mjpg` },
];

export interface CalibratedPose { position: [number, number, number]; target: [number, number, number]; verticalFovDeg: number; yawDeg: number; pitchDeg: number }

export function calibratedPose(camera: TwinCamera): CalibratedPose {
  const pole = wgs84ToLegacy(CAMERA_SITE);
  const yawDeg = camera.heading_deg + camera.yaw_deg + camera.twin_pose.yaw_offset_deg - 90;
  const pitchDeg = camera.pitch_deg + camera.twin_pose.pitch_offset_deg;
  const yaw = MathUtils.degToRad(yawDeg);
  const pitch = MathUtils.degToRad(pitchDeg);
  const x = pole.x + camera.twin_pose.forward_offset_m * Math.cos(yaw);
  const z = pole.y + camera.twin_pose.forward_offset_m * Math.sin(yaw);
  const y = camera.height_m + camera.twin_pose.height_offset_m;
  const target: [number, number, number] = [x + Math.cos(pitch) * Math.cos(yaw), y + Math.sin(pitch), z + Math.cos(pitch) * Math.sin(yaw)];
  return {
    position: [x, y, z], target,
    verticalFovDeg: MathUtils.radToDeg(2 * Math.atan(camera.intrinsics.height / (2 * camera.intrinsics.fy))),
    yawDeg, pitchDeg,
  };
}

export function applyCalibratedCamera(viewer: CityViewer, camera: TwinCamera): void {
  const pose = calibratedPose(camera);
  const groundHeight = viewer.getGroundIndex()?.sample(pose.position[0], pose.position[2]) ?? 0;
  const position: [number, number, number] = [pose.position[0], pose.position[1] + groundHeight, pose.position[2]];
  const target: [number, number, number] = [pose.target[0], pose.target[1] + groundHeight, pose.target[2]];
  viewer.setCameraPoseConstraintsEnabled(false);
  viewer.controls.setEnabled(false);
  viewer.camera.position.set(...position);
  viewer.camera.fov = pose.verticalFovDeg;
  viewer.camera.aspect = camera.intrinsics.width / camera.intrinsics.height;
  viewer.camera.updateProjectionMatrix();
  viewer.camera.lookAt(new Vector3(...target));
  viewer.controls.target.set(...target);
}
