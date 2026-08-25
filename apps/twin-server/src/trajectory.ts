/**
 * GPS trajectory playback — trajectory_player.py port on engine timed routes.
 *
 * Both v1 input shapes are parsed identically to trajectory_player.py:
 *  1. V2X detection list [{object_id, timestamp_utc, gps_location, object_type?}]
 *     — the most frequent object_id wins, records sort by timestamp;
 *  2. simple waypoint list [{t, lat, lon}] — t seconds from start.
 *
 * v1 drove a CARLA vehicle with pure pursuit + PID toward lerped targets;
 * v2 spawns a timedPolyline actor: the engine walks the exact scene-space
 * keyframes so the actor reaches every recorded GPS waypoint at its recorded
 * timestamp (tolerance: one tick, 50 ms). After the final keyframe the engine
 * hands off to physics braking and the actor idles, matching v1's
 * brake-then-idle finish.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ActorKind } from '@simforge/engine';
import type { TwinConfig } from './config.js';
import { sceneFromWgs84 } from './geo.js';
import { kindForBlueprint, type TwinWorld } from './world.js';
import { parseUtcEpoch } from './ghosts.js';

export interface TrajectoryPoint {
  readonly t: number;
  readonly x: number;
  readonly z: number;
}

export interface ParsedTrajectory {
  readonly name: string;
  readonly points: TrajectoryPoint[];
  readonly objectType: string;
}

export function parseTrajectory(name: string, raw: unknown, world: TwinWorld): ParsedTrajectory {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Trajectory JSON must be a non-empty list');
  const first: unknown = raw[0];
  if (!first || typeof first !== 'object') throw new Error('Trajectory entries must be objects');
  if ('gps_location' in first || 'timestamp_utc' in first) return parseV2xFormat(name, raw, world);
  if ('lat' in first && 'lon' in first) return parseSimpleFormat(name, raw, world);
  throw new Error('Unrecognised trajectory format');
}

interface V2xRecord {
  object_id?: string;
  object_type?: string;
  timestamp_utc?: string;
  gps_location?: { latitude?: number; longitude?: number };
}

function parseV2xFormat(name: string, raw: unknown[], world: TwinWorld): ParsedTrajectory {
  const records = raw as V2xRecord[];
  const counts = new Map<string, number>();
  for (const r of records) {
    const id = r.object_id ?? '?';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const target = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const selected = records
    .filter((r) => r.object_id === target && r.gps_location && r.timestamp_utc)
    .sort((a, b) => String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)));

  const points: TrajectoryPoint[] = [];
  let t0: number | null = null;
  for (const r of selected) {
    const lat = r.gps_location?.latitude;
    const lon = r.gps_location?.longitude;
    const t = parseUtcEpoch(r.timestamp_utc);
    if (lat === undefined || lon === undefined || t === null) continue;
    if (t0 === null) t0 = t;
    points.push({ t: t - t0, ...sceneFromWgs84(world.frame, lat, lon) });
  }
  if (points.length < 2) throw new Error(`Trajectory needs >=2 waypoints, got ${points.length}`);
  return { name, points, objectType: selected[0]?.object_type ?? 'car' };
}

function parseSimpleFormat(name: string, raw: unknown[], world: TwinWorld): ParsedTrajectory {
  const points: TrajectoryPoint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as { t?: unknown; lat?: unknown; lon?: unknown };
    const t = Number(r.t);
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push({ t, ...sceneFromWgs84(world.frame, lat, lon) });
  }
  points.sort((a, b) => a.t - b.t);
  if (points.length < 2) throw new Error(`Trajectory needs >=2 waypoints, got ${points.length}`);
  const t0 = points[0]!.t;
  return { name, points: points.map((p) => ({ ...p, t: p.t - t0 })), objectType: 'car' };
}

export class TrajectoryPlayer {
  private readonly world: TwinWorld;
  private readonly shippedDir: string;
  private readonly userDir: string;
  private active: { name: string; actorId: string; startedAtS: number; duration: number; waypoints: number } | null = null;

  constructor(world: TwinWorld, config: TwinConfig) {
    this.world = world;
    this.shippedDir = config.trajectoriesDir;
    this.userDir = config.userTrajectoriesDir;
  }

  listFiles(): Array<{ file: string; waypoints: number; duration: number }> {
    const out: Array<{ file: string; waypoints: number; duration: number }> = [];
    const seen = new Set<string>();
    for (const dir of [this.userDir, this.shippedDir]) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.json') || seen.has(file)) continue;
        seen.add(file);
        try {
          const parsed = parseTrajectory(file, JSON.parse(readFileSync(path.join(dir, file), 'utf8')), this.world);
          out.push({
            file,
            waypoints: parsed.points.length,
            duration: Math.round((parsed.points[parsed.points.length - 1]!.t - parsed.points[0]!.t) * 100) / 100,
          });
        } catch {
          out.push({ file, waypoints: 0, duration: 0 });
        }
      }
    }
    return out;
  }

  saveFile(name: string, data: unknown[]): string {
    const file = name.endsWith('.json') ? name : `${name}.json`;
    const safe = path.basename(file).replaceAll(/[^A-Za-z0-9._-]/g, '_');
    mkdirSync(this.userDir, { recursive: true });
    writeFileSync(path.join(this.userDir, safe), JSON.stringify(data, null, 2));
    return safe;
  }

  private resolve(file: string): string {
    const safe = path.basename(file);
    for (const dir of [this.userDir, this.shippedDir]) {
      const candidate = path.join(dir, safe);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`Trajectory not found: ${safe}`);
  }

  start(file: string, vehicleBlueprint: string): { vehicle_id: string; duration: number; waypoints: number; name: string } {
    if (this.active) throw new Error('Trajectory already playing — stop it first');
    const parsed = parseTrajectory(file, JSON.parse(readFileSync(this.resolve(file), 'utf8')), this.world);
    const kind: ActorKind = parsed.objectType === 'person' ? 'pedestrian' : kindForBlueprint(vehicleBlueprint);
    const result = this.world.spawnTimedRoute({
      category: 'trajectory',
      kind,
      blueprint: vehicleBlueprint,
      points: parsed.points,
      meta: { name: `trajectory ${parsed.name}` },
    });
    if (!result.ok) throw new Error(`Failed to spawn trajectory vehicle: ${result.error}`);
    const duration = parsed.points[parsed.points.length - 1]!.t - parsed.points[0]!.t;
    this.active = {
      name: parsed.name,
      actorId: result.id,
      startedAtS: this.world.time(),
      duration,
      waypoints: parsed.points.length,
    };
    return {
      vehicle_id: result.id,
      duration: Math.round(duration * 100) / 100,
      waypoints: parsed.points.length,
      name: parsed.name,
    };
  }

  stop(): { stopped: boolean } {
    if (!this.active) return { stopped: false };
    this.world.despawn(this.active.actorId);
    this.active = null;
    return { stopped: true };
  }

  status(): Record<string, unknown> {
    if (!this.active) return { active: false };
    const elapsed = this.world.time() - this.active.startedAtS;
    return {
      active: true,
      name: this.active.name,
      elapsed: Math.round(elapsed * 100) / 100,
      duration: Math.round(this.active.duration * 100) / 100,
      vehicle_id: this.active.actorId,
      finished: elapsed >= this.active.duration,
    };
  }

  isActive(): boolean {
    return this.active !== null;
  }
}
