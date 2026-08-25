/**
 * V2X alerting: EVA firetruck proximity/yield (verbatim geometry ports of
 * drive_server.py `_check_emergency_vehicle_proximity` and
 * `_check_yield_to_firetruck`), polygon-zone entry and dynamic-actor
 * circular geofences. Pure geometry over scene/flat-earth coordinates.
 */
import type { LegacyFlatEarthFrame } from '@simforge/maps';
import { pointInPolygon, sceneFromWgs84, type SceneXZ } from './geo.js';
import type { TwinWorld } from './world.js';

export interface V2xAlert {
  readonly id: string;
  readonly message: string;
  readonly signal_type: string;
  readonly distance: number;
}

export interface V2xZone {
  readonly id: string | number;
  readonly name?: string;
  readonly message?: string;
  readonly zone_kind?: string;
  readonly signal_type?: string;
  /** [lon, lat] pairs, per the v1 wire shape. */
  readonly polygon: ReadonlyArray<readonly [number, number]>;
  readonly color?: string;
}

interface EgoPose {
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
}

/**
 * v1 `_check_emergency_vehicle_proximity`: alert for every firetruck within
 * `warnDistM` that sits BEHIND the ego (negative projection of the ego→truck
 * displacement on the ego's forward axis). Stateless; browser dedups by id.
 */
export function evaProximityAlerts(world: TwinWorld, ego: EgoPose, egoId: string, warnDistM: number): V2xAlert[] {
  const thresholdSq = warnDistM * warnDistM;
  // Legacy forward vector: (cos yaw, sin yaw) in the flat-earth plane; scene z
  // equals legacy y, and headingRad = -yawRad, so forward = (cos h, -sin h)…
  // expressed directly in scene coordinates:
  const fx = Math.cos(-ego.headingRad);
  const fz = Math.sin(-ego.headingRad);
  const alerts: V2xAlert[] = [];
  for (const state of world.presentActors()) {
    if (state.id === egoId) continue;
    const meta = world.meta.get(state.id);
    if (!meta?.firetruck) continue;
    const dx = state.x - ego.x;
    const dz = state.z - ego.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > thresholdSq) continue;
    if (fx * dx + fz * dz >= 0) continue; // truck is ahead — no alert
    alerts.push({
      id: `eva:${state.id}`,
      message: 'Firetruck approaching from behind',
      signal_type: 'warning',
      distance: Math.round(Math.sqrt(distSq) * 10) / 10,
    });
  }
  return alerts;
}

/**
 * v1 `_check_yield_to_firetruck`: the ego has been inside a truck's forward
 * cone (ahead of the truck, within warn distance, lateral ≤ 4 m of its
 * centreline) for more than 10 s. `inFrontSince` carries the per-truck
 * debounce state across ticks (owned by the caller, keyed by truck actor id).
 */
export function evaYieldAlerts(
  world: TwinWorld,
  ego: EgoPose,
  egoId: string,
  warnDistM: number,
  inFrontSince: Map<string, number>,
  nowS: number,
): V2xAlert[] {
  const thresholdSq = warnDistM * warnDistM;
  const alerts: V2xAlert[] = [];
  const seen = new Set<string>();
  for (const state of world.presentActors()) {
    if (state.id === egoId) continue;
    const meta = world.meta.get(state.id);
    if (!meta?.firetruck) continue;
    const dx = ego.x - state.x;
    const dz = ego.z - state.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > thresholdSq) continue;
    const fx = Math.cos(-state.headingRad);
    const fz = Math.sin(-state.headingRad);
    // Legacy right vector = forward rotated +90° in the flat-earth plane.
    const rx = -fz;
    const rz = fx;
    const forwardDist = fx * dx + fz * dz;
    const lateral = Math.abs(rx * dx + rz * dz);
    if (forwardDist <= 0 || lateral > 4.0) continue;
    seen.add(state.id);
    const since = inFrontSince.get(state.id);
    if (since === undefined) {
      inFrontSince.set(state.id, nowS);
      continue;
    }
    if (nowS - since < 10.0) continue;
    alerts.push({
      id: `eva-yield:${state.id}`,
      message: 'Yield to clear firetruck path',
      signal_type: 'warning',
      distance: Math.round(Math.sqrt(distSq) * 10) / 10,
    });
  }
  for (const truckId of [...inFrontSince.keys()]) {
    if (!seen.has(truckId)) inFrontSince.delete(truckId);
  }
  return alerts;
}

/** Zone entry: ego inside a synced polygon zone (ray-cast point-in-polygon). */
export function zoneAlerts(zones: readonly V2xZone[], frame: LegacyFlatEarthFrame, ego: SceneXZ): V2xAlert[] {
  const alerts: V2xAlert[] = [];
  for (const zone of zones) {
    if (!Array.isArray(zone.polygon) || zone.polygon.length < 3) continue;
    const scenePoly = zone.polygon.map(([lon, lat]) => sceneFromWgs84(frame, lat, lon));
    if (!pointInPolygon(ego, scenePoly)) continue;
    alerts.push({
      id: `zone:${zone.id}`,
      message: zone.message ?? zone.name ?? 'V2X zone',
      signal_type: zone.signal_type ?? 'warning',
      distance: 0,
    });
  }
  return alerts;
}

/** Dynamic-actor moving circular geofences: ego within radius of the actor. */
export function geofenceAlerts(world: TwinWorld, ego: SceneXZ, egoId: string): V2xAlert[] {
  const alerts: V2xAlert[] = [];
  for (const { meta, state } of world.byCategory('dynamic')) {
    if (meta.id === egoId || !meta.geofenceRadiusM) continue;
    const d = Math.hypot(state.x - ego.x, state.z - ego.z);
    if (d > meta.geofenceRadiusM) continue;
    alerts.push({
      id: `geofence:${meta.id}`,
      message: meta.geofenceMessage ?? `${meta.name} geofence active`,
      signal_type: 'warning',
      distance: Math.round(d * 10) / 10,
    });
  }
  return alerts;
}
