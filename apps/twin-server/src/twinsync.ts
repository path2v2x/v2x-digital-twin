/**
 * TwinSync — local detection polling and recorded-detection replay over the
 * GhostMirror.
 *
 * Replay clock math is the verbatim twin_sync.py contract:
 *   clock = start + (wallNow − wall0) × speed,  speed ∈ [0.25, 8].
 * Replay chunks advance a cursor by at most 30 s per step and apply records
 * with use_detection_ts semantics.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { TwinConfig } from './config.js';
import { GhostMirror, parseUtcEpoch, type DetectionRecord } from './ghosts.js';
import type { TwinWorld } from './world.js';

export type TwinMode = 'live' | 'replay';

export interface ReplayState {
  readonly start: number;
  readonly wall0: number;
  readonly speed: number;
  cursor: number;
}

export interface TwinSyncStatus {
  readonly tracks: number;
  readonly actors: number;
  readonly poll_failures: number;
  readonly detections_url: string;
  readonly mode: TwinMode;
  readonly replay_supported: boolean;
  readonly replay_clock: string | null;
  readonly objects: Array<Record<string, unknown>>;
}

export function epochToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
}

/** Load a recorded-detections file: JSON array or JSONL of records. */
export function loadRecordedDetections(file: string): DetectionRecord[] {
  if (!file || !existsSync(file)) return [];
  const text = readFileSync(file, 'utf8').trim();
  if (text === '') return [];
  const parseRecords = (value: unknown): DetectionRecord[] =>
    Array.isArray(value) ? (value.filter((r) => r && typeof r === 'object') as DetectionRecord[]) : [];
  if (text.startsWith('[')) return parseRecords(JSON.parse(text));
  const out: DetectionRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed as DetectionRecord);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export class TwinSync {
  readonly mirror: GhostMirror;
  private readonly config: TwinConfig;
  private readonly recorded: DetectionRecord[];
  private mode: TwinMode = 'live';
  private replay: ReplayState | null = null;
  private pollFailures = 0;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(world: TwinWorld, config: TwinConfig) {
    this.config = config;
    this.mirror = new GhostMirror(world, config.despawnAfterS);
    this.recorded = loadRecordedDetections(config.recordedDetections)
      .slice()
      .sort((a, b) => String(a.timestamp_utc ?? '').localeCompare(String(b.timestamp_utc ?? '')));
    world.onTick(() => this.mirror.drive());
  }

  get replaySupported(): boolean {
    return this.recorded.length > 0;
  }

  currentMode(): TwinMode {
    return this.mode;
  }

  replayClock(): number | null {
    if (!this.replay) return null;
    return this.replay.start + (Date.now() / 1000 - this.replay.wall0) * this.replay.speed;
  }

  /** Recorded window (for /drive historical reconstruction + validation). */
  recordedWindow(): { start: number; end: number } | null {
    if (this.recorded.length === 0) return null;
    const first = parseUtcEpoch(this.recorded[0]!.timestamp_utc);
    const last = parseUtcEpoch(this.recorded[this.recorded.length - 1]!.timestamp_utc);
    return first !== null && last !== null ? { start: first, end: last } : null;
  }

  recordedInRange(startEpoch: number, endEpoch: number): DetectionRecord[] {
    return this.recorded.filter((r) => {
      const t = parseUtcEpoch(r.timestamp_utc);
      return t !== null && t >= startEpoch && t <= endEpoch;
    });
  }

  start(): void {
    if (this.config.syncLocal) {
      this.timers.push(setInterval(() => void this.pollLocal(), this.config.localPollIntervalS * 1000));
    }
    // Replay stepping shares the local poll cadence, mirroring twin_sync.run().
    this.timers.push(setInterval(() => this.stepReplay(), this.config.localPollIntervalS * 1000));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.mirror.clear();
  }

  /** Flatten fresh detections from the local co-perception contract. */
  private async pollLocal(): Promise<void> {
    if (this.mode !== 'live' || this.stopped) return;
    try {
      const response = await fetch(this.config.detectionsUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const now = Date.now() / 1000;
      const detections: DetectionRecord[] = [];
      const cameras = payload && typeof payload === 'object' && 'cameras' in payload ? payload.cameras : null;
      if (cameras && typeof cameras === 'object') {
        for (const camera of Object.values(cameras)) {
          if (!camera || typeof camera !== 'object') continue;
          const updated = 'ts' in camera && typeof camera.ts === 'number' ? camera.ts : null;
          if (updated === null) continue;
          const age = now - updated;
          if (age < -5 || age > 8) continue;
          const list = 'detections' in camera ? camera.detections : null;
          if (Array.isArray(list)) detections.push(...(list as DetectionRecord[]));
        }
      }
      this.pollFailures = 0;
      if (this.mode === 'live') {
        this.mirror.ingest(detections, now, { lerpDuration: this.config.localPollIntervalS });
      }
    } catch {
      this.pollFailures += 1;
      this.mirror.expire(Date.now() / 1000);
    }
  }


  startReplay(startEpoch: number, speed: number): void {
    if (!this.replaySupported) throw new Error('Replay unavailable: no recorded detections and no range fetcher');
    this.mirror.clear();
    this.mode = 'replay';
    this.replay = {
      start: startEpoch,
      wall0: Date.now() / 1000,
      speed: Math.max(0.25, Math.min(speed, 8)),
      cursor: startEpoch,
    };
  }

  goLive(): void {
    this.mirror.clear();
    this.mode = 'live';
    this.replay = null;
  }

  private stepReplay(): void {
    if (this.mode !== 'replay' || !this.replay) return;
    const clock = this.replayClock();
    if (clock === null || clock <= this.replay.cursor) return;
    const chunkEnd = Math.min(clock, this.replay.cursor + 30);
    const items = this.recordedInRange(this.replay.cursor, chunkEnd)
      .sort((a, b) => String(a.timestamp_utc ?? '').localeCompare(String(b.timestamp_utc ?? '')));
    this.replay.cursor = chunkEnd;
    this.mirror.ingest(items, clock, { useDetectionTs: true, lerpDuration: this.config.localPollIntervalS });
  }

  status(): TwinSyncStatus {
    const clock = this.replayClock();
    const objects = this.mirror.trackStatus();
    return {
      tracks: this.mirror.tracks.size,
      actors: objects.filter((o) => o['actor_present'] === true).length,
      poll_failures: this.pollFailures,
      detections_url: this.config.detectionsUrl,
      mode: this.mode,
      replay_supported: this.replaySupported,
      replay_clock: clock !== null ? epochToIso(clock) : null,
      objects,
    };
  }
}
