/**
 * Zone entry → alert, EVA proximity, EVA yield debounce, geofence — the pure
 * geometry ports of drive_server.py, evaluated against a real world.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { evaProximityAlerts, evaYieldAlerts, geofenceAlerts, zoneAlerts, type V2xZone } from '../src/alerts.js';
import { wgs84FromScene } from '../src/geo.js';
import type { TwinWorld } from '../src/world.js';
import { testWorld } from './helpers.js';

let world: TwinWorld;

beforeAll(async () => {
  world = await testWorld();
});

function zoneAround(x: number, z: number, half: number): V2xZone {
  const corners: Array<readonly [number, number]> = (
    [
      [x - half, z - half],
      [x + half, z - half],
      [x + half, z + half],
      [x - half, z + half],
    ] as const
  ).map(([px, pz]) => {
    const gps = wgs84FromScene(world.frame, { x: px, z: pz });
    return [gps.lon, gps.lat] as const;
  });
  return { id: 'z1', name: 'Test zone', message: 'Zone entered', zone_kind: 'polygon', signal_type: 'warning', polygon: corners, color: '#f00' };
}

describe('zones', () => {
  it('raises an alert when the ego is inside the polygon, none outside', () => {
    const zone = zoneAround(100, 100, 20);
    const inside = zoneAlerts([zone], world.frame, { x: 100, z: 100 });
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ id: 'zone:z1', message: 'Zone entered', signal_type: 'warning', distance: 0 });
    expect(zoneAlerts([zone], world.frame, { x: 130, z: 100 })).toHaveLength(0);
    // degenerate polygon (< 3 vertices) never alerts
    const degenerate = { ...zone, polygon: zone.polygon.slice(0, 2) };
    expect(zoneAlerts([degenerate], world.frame, { x: 100, z: 100 })).toHaveLength(0);
  });
});

describe('EVA firetruck alerts', () => {
  it('proximity: fires only for a firetruck BEHIND the ego within 20 m', () => {
    // ego at origin facing legacy yaw 0 (east; scene heading 0).
    const ego = { x: 0, z: 0, headingRad: 0 };
    const behind = world.spawnFreeform({
      category: 'scenario',
      kind: 'truck',
      blueprint: 'vehicle.carlamotors.firetruck',
      pose: { x: -15, z: 0, headingRad: 0 },
    });
    expect(behind.ok).toBe(true);
    world.session.advance(1);
    const alerts = evaProximityAlerts(world, ego, 'ego-x', 20);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toBe('Firetruck approaching from behind');
    expect(alerts[0]!.distance).toBeCloseTo(15, 0);

    // Ahead of the ego → no alert (v1 forward-projection rule).
    const ahead = evaProximityAlerts(world, { x: -40, z: 0, headingRad: 0 }, 'ego-x', 20);
    expect(ahead).toHaveLength(0);
    // Out of range → no alert.
    expect(evaProximityAlerts(world, { x: 40, z: 0, headingRad: 0 }, 'ego-x', 20)).toHaveLength(0);
    if (behind.ok) world.despawn(behind.id);
  });

  it('yield: fires only after 10 s of sustained blocking in the truck cone', () => {
    const truck = world.spawnFreeform({
      category: 'scenario',
      kind: 'truck',
      blueprint: 'vehicle.carlamotors.firetruck',
      pose: { x: 50, z: 50, headingRad: 0 }, // facing legacy east
    });
    expect(truck.ok).toBe(true);
    world.session.advance(1);
    const egoAhead = { x: 60, z: 50.5, headingRad: 0 }; // 10 m ahead, in lane
    const since = new Map<string, number>();
    // First sighting arms the debounce, no alert.
    expect(evaYieldAlerts(world, egoAhead, 'ego-x', 20, since, 1000)).toHaveLength(0);
    // 9 s later: still below the 10 s debounce.
    expect(evaYieldAlerts(world, egoAhead, 'ego-x', 20, since, 1009)).toHaveLength(0);
    // 10+ s later: alert fires.
    const fired = evaYieldAlerts(world, egoAhead, 'ego-x', 20, since, 1010.5);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.message).toBe('Yield to clear firetruck path');
    // Leaving the cone resets the timer (v1 semantics).
    expect(evaYieldAlerts(world, { x: 40, z: 50, headingRad: 0 }, 'ego-x', 20, since, 1011)).toHaveLength(0);
    expect(evaYieldAlerts(world, egoAhead, 'ego-x', 20, since, 1012)).toHaveLength(0); // re-armed, not fired
    if (truck.ok) world.despawn(truck.id);
  });
});

describe('geofences', () => {
  it('alerts when the ego is inside a dynamic actor geofence', () => {
    const dyn = world.spawnFreeform({
      category: 'dynamic',
      kind: 'car',
      blueprint: 'vehicle.nissan.patrol',
      pose: { x: -80, z: -80, headingRad: 0 },
      meta: { geofenceRadiusM: 35, geofenceMessage: 'Patrol geofence' },
    });
    expect(dyn.ok).toBe(true);
    world.session.advance(1);
    const inside = geofenceAlerts(world, { x: -70, z: -80 }, 'ego-x');
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ message: 'Patrol geofence', signal_type: 'warning' });
    expect(inside[0]!.distance).toBeCloseTo(10, 0);
    expect(geofenceAlerts(world, { x: -20, z: -80 }, 'ego-x')).toHaveLength(0);
    if (dyn.ok) world.despawn(dyn.id);
  });
});
