/**
 * Coordinate plumbing. Three frames (see engine
 * docs/engineering/v2x-coordinate-contract.md):
 *  - WGS-84 lat/lon (wire: detections, zones, trajectories, cameras)
 *  - legacy flat-earth ("CARLA world"): x east, y = negated northing
 *  - scene (scene-state.v1): x east, z = negated northing, y up
 *
 * Numerically, scene {x, z} === flat-earth {x, y}: both negate the northing.
 * The v1 JSON protocol's `pos` arrays are flat-earth [x, y(, z=0)].
 *
 * Yaw: legacy CARLA yaw (degrees) = atan2(y_fe, x_fe) of the facing direction
 * = atan2(z_scene, x_scene). Empirically the engine's scene headingRad is the
 * mathematical angle in the (x, -z) plane, i.e. carlaYawDeg = -deg(sceneHeading).
 */
import { readFileSync } from 'node:fs';
import { LegacyFlatEarthFrame } from '@simforge/maps';

export interface SceneXZ {
  readonly x: number;
  readonly z: number;
}

export function flatEarthFromXodr(xodrPath: string): LegacyFlatEarthFrame {
  const head = readFileSync(xodrPath, 'utf8').slice(0, 262_144);
  const cdata = /<geo[Rr]eference[^>]*><!\[CDATA\[([^\]]*)\]\]>/.exec(head);
  const plain = /<geo[Rr]eference[^>]*>([^<]*)</.exec(head);
  const proj = (cdata?.[1] ?? plain?.[1] ?? '').replaceAll('&amp;', '&').replaceAll('&quot;', '"');
  return LegacyFlatEarthFrame.fromProjString(proj);
}

/** WGS-84 -> scene ground point (scene z equals the legacy CARLA y). */
export function sceneFromWgs84(frame: LegacyFlatEarthFrame, lat: number, lon: number): SceneXZ {
  const fe = frame.wgs84ToLocal(lat, lon);
  return { x: fe.x, z: fe.y };
}

/** scene ground point -> WGS-84. */
export function wgs84FromScene(frame: LegacyFlatEarthFrame, p: SceneXZ): { lat: number; lon: number } {
  return frame.localToWgs84(p.x, p.z);
}

/** Engine scene headingRad -> legacy CARLA yaw degrees. */
export function carlaYawDegFromSceneHeading(sceneHeadingRad: number): number {
  const deg = (-sceneHeadingRad * 180) / Math.PI;
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/** Legacy CARLA yaw degrees -> engine scene headingRad. */
export function sceneHeadingFromCarlaYawDeg(yawDeg: number): number {
  return (-yawDeg * Math.PI) / 180;
}

/** Planar distance between two scene points. */
export function planarDist(a: SceneXZ, b: SceneXZ): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Ray-cast point-in-polygon in the flat-earth plane (verbatim geometry of the
 * v1 zone evaluation; polygon vertices arrive as [lon, lat] pairs).
 */
export function pointInPolygon(p: SceneXZ, polygon: readonly SceneXZ[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
