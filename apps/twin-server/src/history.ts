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
    const buckets: CoverageBucket[] = Array.from({ length: count }, (_, index) => ({
      start: iso(startMs + index * bucketMs),
      detections: 0,
      objects: 0,
    }));
    const rows = this.selectCoverage.all(startMs, bucketMs, startMs, endMs) as unknown as CoverageRow[];
    for (const row of rows) {
      const bucket = buckets[row.bucket_index];
      if (!bucket) continue;
      buckets[row.bucket_index] = {
        start: bucket.start,
        detections: Number(row.detections),
        objects: Number(row.objects),
      };
    }
    return buckets;
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
