/**
 * /twin connection handler — twin_hello + twin_cameras on connect, JSON
 * replay/live/status control, twin_clock every second. Binary truth_frame
 * relay is wired by server.ts (shared with /drive).
 */
import type { TwinConfig } from './config.js';
import { buildTwinCameras } from './cameras.js';
import { activeSessionCount } from './drive.js';
import { parseUtcEpoch } from './ghosts.js';
import type { TwinSync } from './twinsync.js';
import type { TwinWorld } from './world.js';

type Json = Record<string, unknown>;

/** Global replay ownership: one controlling connection at a time (v1 rule). */
let replayOwner: TwinConnection | null = null;

export class TwinConnection {
  private readonly world: TwinWorld;
  private readonly sync: TwinSync;
  private readonly config: TwinConfig;
  readonly cameraId: string | null;

  constructor(world: TwinWorld, sync: TwinSync, config: TwinConfig, query: URLSearchParams) {
    this.world = world;
    this.sync = sync;
    this.config = config;
    const controlOnly = ['1', 'true'].includes(query.get('control') ?? '0');
    this.cameraId = controlOnly ? null : (query.get('cam') ?? 'ch1');
  }

  /** Messages the server sends immediately on connect, in order. */
  helloMessages(host: string, feedModes: Record<string, string> = {}): Json[] {
    const cameras = buildTwinCameras(this.config, this.world.xodrSha256, host, feedModes);
    const cameraIds = cameras.cameras.map((c) => c.id);
    const camera = this.cameraId !== null ? cameras.cameras.find((c) => c.id === this.cameraId) ?? null : null;
    const publicOrigin = this.config.publicHttpOrigin.replace(/\/+$/, '');
    const replayUrls = publicOrigin === ''
      ? { archive_url_template: null, coverage_url: null, history_url: null }
      : {
          archive_url_template: this.config.archiveUrlTemplate || null,
          coverage_url: `${publicOrigin}/detections/coverage`,
          history_url: `${publicOrigin}/detections/history`,
        };
    const hello: Json = {
      type: 'twin_hello',
      camera_id: this.cameraId,
      camera_model: camera,
      width: camera?.intrinsics['width'] ?? 2560,
      height: camera?.intrinsics['height'] ?? 1920,
      fps: 1 / this.world.dt,
      cameras: cameraIds,
      rig: { width: 2560, height: 1920, fps: 1 / this.world.dt, cameras: cameraIds },
      sync: this.sync.status(),
      replay: {
        retention_hours: this.config.historyRetentionHours,
        ...replayUrls,
      },
    };
    return [hello, { ...cameras }];
  }

  modePayload(includeObjects: boolean): Json {
    const status = this.sync.status();
    const payload: Json = {
      type: 'twin_mode',
      mode: status.mode,
      replay_supported: status.replay_supported,
      replay_clock: status.replay_clock,
      replay_speed: status.replay_speed,
      tracks: status.tracks,
    };
    if (includeObjects) {
      payload['actors'] = status.actors;
      payload['objects'] = status.objects;
    }
    return payload;
  }

  clockPayload(): Json {
    return { ...this.modePayload(false), type: 'twin_clock' };
  }

  handle(raw: string): Json {
    let msg: Json;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      msg = parsed as Json;
    } catch {
      return { type: 'twin_error', message: 'Invalid JSON' };
    }
    const type = typeof msg['type'] === 'string' ? msg['type'] : '';
    switch (type) {
      case 'twin_replay': {
        if (activeSessionCount() > 0) {
          return { type: 'twin_error', message: 'End active Drive sessions before twin replay' };
        }
        if (replayOwner !== null && replayOwner !== this) {
          return { type: 'twin_error', message: 'Twin replay is controlled by another connection' };
        }
        const startEpoch = parseUtcEpoch(msg['start']);
        if (startEpoch === null) return { type: 'twin_error', message: "twin_replay requires ISO 'start'" };
        const now = Date.now() / 1000;
        if (startEpoch > now || now - startEpoch > this.config.historyRetentionHours * 3600) {
          return {
            type: 'twin_error',
            message: `Replay start must be within the past ${this.config.historyRetentionHours} hours`,
          };
        }
        try {
          const requestedSpeed = msg['speed'] === undefined ? 1 : Number(msg['speed']);
          this.sync.startReplay(startEpoch, requestedSpeed);
        } catch (error) {
          return { type: 'twin_error', message: error instanceof Error ? error.message : String(error) };
        }
        replayOwner = this;
        return this.modePayload(false);
      }
      case 'twin_live':
        this.sync.goLive();
        replayOwner = null;
        return this.modePayload(false);
      case 'twin_status':
        return this.modePayload(true);
      default:
        return { type: 'twin_error', message: `Unknown twin message: ${type}` };
    }
  }

  /** v1: the replay owner's disconnect returns the twin to live. */
  dispose(): void {
    if (replayOwner === this) {
      try {
        this.sync.goLive();
      } catch (error) {
        console.error('[twin] failed to restore live mode on disconnect:', error);
      }
      replayOwner = null;
    }
  }
}
