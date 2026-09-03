/**
 * TwinSync persists accepted local camera summaries and replays them against
 * the shared ghost mirror using an epoch clock.
 */
import type { TwinConfig } from './config.js';
import { GhostMirror, type DetectionRecord } from './ghosts.js';
import { DetectionHistory } from './history.js';
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
  readonly replay_speed: number;
  readonly objects: Array<Record<string, unknown>>;
}

export function epochToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

export class TwinSync {
  readonly mirror: GhostMirror;
  readonly history: DetectionHistory | null;
  private readonly config: TwinConfig;
  private mode: TwinMode = 'live';
  private replay: ReplayState | null = null;
  private pollFailures = 0;
  private pollInFlight = false;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(world: TwinWorld, config: TwinConfig) {
    this.config = config;
    this.mirror = new GhostMirror(world, config.despawnAfterS);
    try {
      this.history = new DetectionHistory(config.historyDb, config.historyRetentionHours);
    } catch (error) {
      console.error(`[twin-sync] detection history unavailable: ${error instanceof Error ? error.message : String(error)}`);
      this.history = null;
    }
    world.onTick(() => this.mirror.drive());
  }

  get replaySupported(): boolean {
    return this.history !== null;
  }

  currentMode(): TwinMode {
    return this.mode;
  }

  replaySpeed(): number {
    return this.replay?.speed ?? 1;
  }

  replayClock(): number | null {
    if (!this.replay) return null;
    return this.replay.start + (Date.now() / 1000 - this.replay.wall0) * this.replay.speed;
  }

  clockNow(): number {
    return this.replayClock() ?? Date.now() / 1000;
  }

  recordedInRange(startEpoch: number, endEpoch: number): DetectionRecord[] {
    if (!this.history) return [];
    return this.history.range(startEpoch * 1000, endEpoch * 1000 + 1, 100_000).items.map((item) => ({
      object_id: item.object_id,
      object_type: item.object_type,
      confidence: item.confidence,
      gps_location: { lat: item.lat, lon: item.lon },
      timestamp_utc: item.ts,
    }));
  }

  start(): void {
    const intervalMs = 1000 / this.config.pollHz;
    if (this.config.syncLocal) {
      this.timers.push(setInterval(() => void this.pollLocal(), intervalMs));
    }
    this.timers.push(setInterval(() => this.stepReplay(), intervalMs));
    this.timers.push(setInterval(() => this.history?.prune(Date.now()), 10 * 60 * 1000));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.mirror.clear();
    this.history?.close();
  }

  /** Poll and persist each fresh per-camera summary before live flattening. */
  private async pollLocal(): Promise<void> {
    if (this.mode !== 'live' || this.stopped || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const response = await fetch(this.config.detectionsUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const now = Date.now() / 1000;
      const detections: DetectionRecord[] = [];
      const cameras = payload && typeof payload === 'object' && 'cameras' in payload ? payload.cameras : null;
      if (cameras && typeof cameras === 'object') {
        for (const [cameraId, camera] of Object.entries(cameras)) {
          if (!camera || typeof camera !== 'object') continue;
          const updated = 'ts' in camera && typeof camera.ts === 'number' ? camera.ts : null;
          if (updated === null) continue;
          const age = now - updated;
          if (age < -5 || age > 8) continue;
          const value = 'detections' in camera ? camera.detections : null;
          const list = Array.isArray(value) ? (value as DetectionRecord[]) : [];
          this.history?.recordSummary(cameraId, updated, list);
          detections.push(...list);
        }
      }
      this.pollFailures = 0;
      if (this.mode === 'live') {
        this.mirror.ingest(detections, now, { lerpDuration: 1 / this.config.pollHz });
      }
    } catch {
      this.pollFailures += 1;
      this.mirror.expire(Date.now() / 1000);
    } finally {
      this.pollInFlight = false;
    }
  }

  startReplay(startEpoch: number, speed: number): void {
    if (!this.history) throw new Error('Replay unavailable: detection history could not be opened');
    const replaySpeed = speed === 0 ? 0 : Math.max(0.25, Math.min(Number.isFinite(speed) ? speed : 1, 8));
    this.mirror.clear();
    this.mode = 'replay';
    this.replay = {
      start: startEpoch,
      wall0: Date.now() / 1000,
      speed: replaySpeed,
      cursor: startEpoch,
    };

    // Reconstruct tracks still alive at the seek point, then advance from it.
    const recent = this.recordedInRange(startEpoch - this.config.despawnAfterS, startEpoch);
    this.mirror.ingest(recent, startEpoch, { useDetectionTs: true, lerpDuration: 1 / this.config.pollHz });
    this.mirror.setPaused(replaySpeed === 0);
  }

  goLive(): void {
    this.mirror.clear();
    this.mirror.setPaused(false);
    this.mode = 'live';
    this.replay = null;
  }

  stepReplay(): void {
    if (this.mode !== 'replay' || !this.replay || this.replay.speed === 0) return;
    const clock = this.replayClock();
    if (clock === null || clock <= this.replay.cursor) return;
    const chunkEnd = Math.min(clock, this.replay.cursor + 30);
    const items = this.recordedInRange(this.replay.cursor, chunkEnd);
    this.replay.cursor = chunkEnd;
    this.mirror.ingest(items, clock, { useDetectionTs: true, lerpDuration: 1 / this.config.pollHz });
    this.mirror.expire(clock);
  }

  status(): TwinSyncStatus {
    const clock = this.replayClock();
    const objects = this.mirror.trackStatus();
    return {
      tracks: this.mirror.tracks.size,
      actors: objects.filter((object) => object['actor_present'] === true).length,
      poll_failures: this.pollFailures,
      detections_url: this.config.detectionsUrl,
      mode: this.mode,
      replay_supported: this.replaySupported,
      replay_clock: clock !== null ? epochToIso(clock) : null,
      replay_speed: this.replaySpeed(),
      objects,
    };
  }
}
