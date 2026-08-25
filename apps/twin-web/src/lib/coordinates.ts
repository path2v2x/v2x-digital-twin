export interface GeoOrigin { lat: number; lon: number }
export interface Wgs84Point { lat: number; lon: number }
export interface LegacyPoint { x: number; y: number }

export const RICHMOND_ORIGIN: GeoOrigin = { lat: 37.9150891287087, lon: -122.333308830857 };
export const METERS_PER_DEGREE = 111_320;

/** Frozen deployed-twin transform. `y` is negated northing and maps directly to Three.js scene z. */
export function wgs84ToLegacy(point: Wgs84Point, origin: GeoOrigin = RICHMOND_ORIGIN): LegacyPoint {
  return {
    x: (point.lon - origin.lon) * METERS_PER_DEGREE * Math.cos(origin.lat * Math.PI / 180),
    y: -(point.lat - origin.lat) * METERS_PER_DEGREE,
  };
}

export function legacyToWgs84(point: LegacyPoint, origin: GeoOrigin = RICHMOND_ORIGIN): Wgs84Point {
  return {
    lat: origin.lat - point.y / METERS_PER_DEGREE,
    lon: origin.lon + point.x / (METERS_PER_DEGREE * Math.cos(origin.lat * Math.PI / 180)),
  };
}

export function wgs84ToScene(point: Wgs84Point, elevation = 0): [number, number, number] {
  const projected = wgs84ToLegacy(point);
  return [projected.x, elevation, projected.y];
}

export function sceneToWgs84(position: readonly [number, number, number]): Wgs84Point {
  return legacyToWgs84({ x: position[0], y: position[2] });
}
