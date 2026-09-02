/**
 * Coordinate plumbing between WGS-84, the map bundle's legacy flat-earth
 * frame (x east, y negated northing), and scene-state coordinates (x east,
 * z negated northing, y up). The JSON drive protocol uses flat-earth
 * `[x, y, z?]` positions and clockwise yaw degrees.
 */
import { readFileSync } from 'node:fs';
import { LegacyFlatEarthFrame } from '@simforge-oss/maps';

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

/** WGS-84 -> scene ground point. */
export function sceneFromWgs84(frame: LegacyFlatEarthFrame, lat: number, lon: number): SceneXZ {
  const fe = frame.wgs84ToLocal(lat, lon);
  return { x: fe.x, z: fe.y };
}

/** scene ground point -> WGS-84. */
export function wgs84FromScene(frame: LegacyFlatEarthFrame, p: SceneXZ): { lat: number; lon: number } {
  return frame.localToWgs84(p.x, p.z);
}

/** Engine scene headingRad -> clockwise protocol yaw degrees. */
export function legacyYawDegFromSceneHeading(sceneHeadingRad: number): number {
  const deg = (-sceneHeadingRad * 180) / Math.PI;
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/** Clockwise protocol yaw degrees -> engine scene headingRad. */
export function sceneHeadingFromLegacyYawDeg(yawDeg: number): number {
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
