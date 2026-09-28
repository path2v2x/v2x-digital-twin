import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DetectionRecord } from './ghosts.js';

export interface HistoryItem {
  readonly ts: string;
  readonly camera: string;
  readonly object_id: string;
  readonly object_type: string;
  readonly confidence: number;
  readonly lat: number;
  readonly lon: number;
}

export interface HistoryRange {
  readonly items: HistoryItem[];
  readonly next: string | null;
}

export interface CoverageBucket {
  readonly start: string;
  readonly detections: number;
  readonly objects: number;
}

export interface ObjectSummary {
  readonly object_id: string;
  readonly object_type: string;
  readonly first_seen: string;
  readonly last_seen: string;
  readonly count: number;
  readonly max_confidence: number;
  readonly cameras: string[];
  readonly last_lat: number;
  readonly last_lon: number;
}

export type EventKind = 'pedestrian' | 'cyclist' | 'vehicle' | 'large_vehicle';

/** Same-kind tracks, merged across cameras while they follow each other within `EVENT_MERGE_GAP_MS`. */
export interface DetectionEvent {
  readonly id: string;
  readonly kind: EventKind;
  readonly start: string;
  readonly end: string;
  readonly objects: number;
  readonly detections: number;
  /** Cameras by detections, most first. */
  readonly cameras: readonly { readonly camera: string; readonly detections: number }[];
}

/** A track needs this much evidence to count as an event (the web replay applies the same floor). */
export const EVENT_MIN_DETECTIONS = 5;
export const EVENT_MIN_SPAN_MS = 1_000;
/** Vehicles that move less than this are parked, not events. */
export const PARKED_MAX_EXTENT_M = 3;
export const EVENT_MERGE_GAP_MS = 5_000;

const EVENT_KINDS: Record<string, EventKind> = {
  person: 'pedestrian',
  pedestrian: 'pedestrian',
  bicycle: 'cyclist',
  motorcycle: 'cyclist',
  car: 'vehicle',
  van: 'vehicle',
  truck: 'large_vehicle',
  bus: 'large_vehicle',
};

const METRES_PER_DEGREE = 111_320;

interface DetectionRow {
  ts_ms: number;
  camera: string;
  object_id: string;
  object_type: string;
  confidence: number | null;
  lat: number;
  lon: number;
}

interface CoverageRow {
  bucket_index: number;
  detections: number;
  objects: number;
}

interface ObjectRow {
  object_id: string;
  object_type: string;
  first_ms: number;
  last_ms: number;
  count: number;
  max_confidence: number | null;
  cameras: string;
  last_lat: number;
  last_lon: number;
}

interface TrackRow {
  object_id: string;
  object_type: string;
  camera: string;
  count: number;
  first_ms: number;
  last_ms: number;
  min_lat: number;
  max_lat: number;
  min_lon: number;
  max_lon: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class DetectionHistory {
  private readonly db: DatabaseSync;
  private readonly retentionMs: number;
  private readonly insertFrame: StatementSync;
  private readonly insertDetection: StatementSync;
  private readonly selectRange: StatementSync;
  private readonly selectCoverage: StatementSync;
  private readonly selectTracks: StatementSync;
  private readonly selectObjects: StatementSync;
  private readonly deleteDetections: StatementSync;
  private readonly deleteFrames: StatementSync;

  constructor(file: string, retentionHours = 72) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.retentionMs = retentionHours * 3600 * 1000;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS detections (
        ts_ms INTEGER NOT NULL,
        camera TEXT NOT NULL,
        object_id TEXT NOT NULL,
        object_type TEXT NOT NULL,
        confidence REAL,
        lat REAL NOT NULL,
        lon REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS detections_ts_ms_idx ON detections(ts_ms);
      CREATE TABLE IF NOT EXISTS frames (
        camera TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        PRIMARY KEY(camera, ts_ms)
      );
    `);
    this.insertFrame = this.db.prepare('INSERT OR IGNORE INTO frames(camera, ts_ms) VALUES (?, ?)');
    this.insertDetection = this.db.prepare(
      'INSERT INTO detections(ts_ms, camera, object_id, object_type, confidence, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.selectRange = this.db.prepare(`
      SELECT ts_ms, camera, object_id, object_type, confidence, lat, lon
      FROM detections
      WHERE ts_ms >= ? AND ts_ms < ?
      ORDER BY ts_ms ASC, camera ASC, object_id ASC
      LIMIT ?
    `);
    this.selectCoverage = this.db.prepare(`
      SELECT CAST((ts_ms - ?) / ? AS INTEGER) AS bucket_index,
             COUNT(*) AS detections,
             COUNT(DISTINCT object_id) AS objects
      FROM detections
      WHERE ts_ms >= ? AND ts_ms < ?
      GROUP BY bucket_index
      ORDER BY bucket_index
    `);
    this.selectTracks = this.db.prepare(`
      SELECT object_id, object_type, camera,
             COUNT(*) AS count, MIN(ts_ms) AS first_ms, MAX(ts_ms) AS last_ms,
             MIN(lat) AS min_lat, MAX(lat) AS max_lat, MIN(lon) AS min_lon, MAX(lon) AS max_lon
      FROM detections
      WHERE ts_ms >= ? AND ts_ms < ?
      GROUP BY object_id, camera
    `);
    this.selectObjects = this.db.prepare(`
      SELECT d.object_id,
             d.object_type,
             MIN(d.ts_ms) AS first_ms,
             MAX(d.ts_ms) AS last_ms,
             COUNT(*) AS count,
             MAX(d.confidence) AS max_confidence,
             GROUP_CONCAT(DISTINCT d.camera) AS cameras,
             (SELECT lat FROM detections l WHERE l.object_id = d.object_id AND l.ts_ms >= ? AND l.ts_ms < ?
                ORDER BY l.ts_ms DESC LIMIT 1) AS last_lat,
             (SELECT lon FROM detections l WHERE l.object_id = d.object_id AND l.ts_ms >= ? AND l.ts_ms < ?
                ORDER BY l.ts_ms DESC LIMIT 1) AS last_lon
      FROM detections d
      WHERE d.ts_ms >= ? AND d.ts_ms < ?
      GROUP BY d.object_id
      ORDER BY last_ms DESC
      LIMIT ?
    `);
    this.deleteDetections = this.db.prepare('DELETE FROM detections WHERE ts_ms < ?');
    this.deleteFrames = this.db.prepare('DELETE FROM frames WHERE ts_ms < ?');
  }

  recordSummary(camera: string, tsSec: number, detections: readonly DetectionRecord[]): boolean {
    if (camera === '' || !Number.isFinite(tsSec)) return false;
    const tsMs = Math.round(tsSec * 1000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.insertFrame.run(camera, tsMs);
      if (Number(inserted.changes) === 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      for (const detection of detections) {
        const lat = detection.gps_location?.lat;
        const lon = detection.gps_location?.lon;
        if (!detection.object_id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const confidence = detection.confidence ?? detection.confidence_score ?? null;
        this.insertDetection.run(
          tsMs,
          camera,
          detection.object_id,
          detection.object_type ?? 'car',
          Number.isFinite(confidence) ? confidence : null,
          lat!,
          lon!,
        );
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  range(startMs: number, endMs: number, limit: number): HistoryRange {
    const rows = this.selectRange.all(startMs, endMs, limit + 1) as unknown as DetectionRow[];
    const returned = rows.slice(0, limit);
    return {
      items: returned.map((row) => ({
        ts: iso(row.ts_ms),
        camera: row.camera,
        object_id: row.object_id,
        object_type: row.object_type,
        confidence: row.confidence ?? 0,
        lat: row.lat,
        lon: row.lon,
      })),
      next: rows.length > limit ? iso(rows[limit]!.ts_ms) : null,
    };
  }

  coverage(startMs: number, endMs: number, bucketSec: number): CoverageBucket[] {
    const bucketMs = bucketSec * 1000;
    const count = Math.ceil((endMs - startMs) / bucketMs);
    const buckets = Array.from({ length: count }, (_, index) => ({
      start: iso(startMs + index * bucketMs),
      detections: 0,
      objects: 0,
    }));
    const rows = this.selectCoverage.all(startMs, bucketMs, startMs, endMs) as unknown as CoverageRow[];
    for (const row of rows) {
      const bucket = buckets[row.bucket_index];
      if (!bucket) continue;
      bucket.detections = Number(row.detections);
      bucket.objects = Number(row.objects);
    }
    return buckets;
  }

  /** Moving objects in `[startMs, endMs)`, clustered into per-kind events; parked vehicles and fragments are dropped. */
  events(startMs: number, endMs: number): DetectionEvent[] {
    const rows = this.selectTracks.all(startMs, endMs) as unknown as TrackRow[];
    const tracks = new Map<string, { kind: EventKind; count: number; firstMs: number; lastMs: number; minLat: number; maxLat: number; minLon: number; maxLon: number; cameras: Map<string, number> }>();
    for (const row of rows) {
      const count = Number(row.count);
      const track = tracks.get(row.object_id);
      if (!track) {
        tracks.set(row.object_id, {
          kind: EVENT_KINDS[row.object_type] ?? 'vehicle',
          count,
          firstMs: row.first_ms,
          lastMs: row.last_ms,
          minLat: row.min_lat,
          maxLat: row.max_lat,
          minLon: row.min_lon,
          maxLon: row.max_lon,
          cameras: new Map([[row.camera, count]]),
        });
        continue;
      }
      track.count += count;
      track.firstMs = Math.min(track.firstMs, row.first_ms);
      track.lastMs = Math.max(track.lastMs, row.last_ms);
      track.minLat = Math.min(track.minLat, row.min_lat);
      track.maxLat = Math.max(track.maxLat, row.max_lat);
      track.minLon = Math.min(track.minLon, row.min_lon);
      track.maxLon = Math.max(track.maxLon, row.max_lon);
      track.cameras.set(row.camera, (track.cameras.get(row.camera) ?? 0) + count);
    }

    const moving = [...tracks.values()].filter((track) => {
      if (track.count < EVENT_MIN_DETECTIONS || track.lastMs - track.firstMs < EVENT_MIN_SPAN_MS) return false;
      if (track.kind === 'pedestrian' || track.kind === 'cyclist') return true;
      const cosLat = Math.cos(((track.minLat + track.maxLat) / 2) * Math.PI / 180);
      const extentM = Math.hypot((track.maxLat - track.minLat) * METRES_PER_DEGREE, (track.maxLon - track.minLon) * METRES_PER_DEGREE * cosLat);
      return extentM >= PARKED_MAX_EXTENT_M;
    }).sort((a, b) => a.firstMs - b.firstMs || a.lastMs - b.lastMs);

    const events: DetectionEvent[] = [];
    const open = new Map<EventKind, { kind: EventKind; startMs: number; endMs: number; objects: number; detections: number; cameras: Map<string, number> }>();
    const close = (event: { kind: EventKind; startMs: number; endMs: number; objects: number; detections: number; cameras: Map<string, number> }) => {
      events.push({
        id: `${event.kind}-${event.startMs}`,
        kind: event.kind,
        start: iso(event.startMs),
        end: iso(event.endMs),
        objects: event.objects,
        detections: event.detections,
        cameras: [...event.cameras].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([camera, detections]) => ({ camera, detections })),
      });
    };
    for (const track of moving) {
      const current = open.get(track.kind);
      if (current && track.firstMs <= current.endMs + EVENT_MERGE_GAP_MS) {
        current.endMs = Math.max(current.endMs, track.lastMs);
        current.objects += 1;
        current.detections += track.count;
        for (const [camera, count] of track.cameras) current.cameras.set(camera, (current.cameras.get(camera) ?? 0) + count);
        continue;
      }
      if (current) close(current);
      open.set(track.kind, { kind: track.kind, startMs: track.firstMs, endMs: track.lastMs, objects: 1, detections: track.count, cameras: new Map(track.cameras) });
    }
    for (const event of open.values()) close(event);
    return events.sort((a, b) => a.start.localeCompare(b.start) || a.kind.localeCompare(b.kind));
  }

  objects(startMs: number, endMs: number, limit: number): ObjectSummary[] {
    const rows = this.selectObjects.all(
      startMs, endMs, startMs, endMs, startMs, endMs, limit,
    ) as unknown as ObjectRow[];
    return rows.map((row) => ({
      object_id: row.object_id,
      object_type: row.object_type,
      first_seen: iso(row.first_ms),
      last_seen: iso(row.last_ms),
      count: Number(row.count),
      max_confidence: row.max_confidence ?? 0,
      cameras: row.cameras.split(',').sort(),
      last_lat: row.last_lat,
      last_lon: row.last_lon,
    }));
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteDetections.run(cutoff);
      this.deleteFrames.run(cutoff);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
