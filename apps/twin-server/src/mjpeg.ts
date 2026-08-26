/**
 * MJPEG camera feeds: GET /streams/ch{1..4}.mjpg — multipart JPEG streaming.
 *
 * Source per channel, in preference order:
 *  1. LIVE — the real Richmond site camera via Kinesis Video Streams HLS
 *     (stream `<prefix><channel>`, resolved with the aws CLI; the session URL
 *     expires so ffmpeg exit simply triggers a fresh resolve+relaunch).
 *  2. REPLAY fallback — the recorded site footage looped with a per-channel
 *     crop, used when live resolution fails; a timer periodically retries live.
 *
 * One ffmpeg per channel decodes into an MJPEG pipe; the HTTP layer holds only
 * the latest JPEG per channel and writes it to every client at the configured fps.
 */
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { WebSocket } from 'ws';

export const CHANNELS = ['ch1', 'ch2', 'ch3', 'ch4'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Per-channel crop expressions (input is scaled to 960x720 first). */
const CHANNEL_FILTER: Record<Channel, string> = {
  ch1: 'scale=960:720,crop=640:480:0:0',
  ch2: 'scale=960:720,crop=640:480:320:0',
  ch3: 'scale=960:720,crop=640:480:0:240',
  ch4: 'scale=960:720,crop=640:480:320:240',
};

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export type FeedMode = 'live' | 'replay' | 'starting';

const CAMERA_FEED_MAGIC = Buffer.from('SFCF');
const CAMERA_FEED_VERSION = 1;
const CAMERA_FEED_HEADER_BYTES = 8;
const WS_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

const MODE_CODE: Record<FeedMode, number> = {
  starting: 0,
  live: 1,
  replay: 2,
};

interface MultiplexSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Buffer | string, options?: { binary?: boolean }): void;
  on(event: 'close', listener: () => void): unknown;
}

interface MultiplexFrame {
  readonly channel: Channel;
  readonly mode: FeedMode;
  readonly jpeg: Buffer | null;
  readonly revision: number;
}

/** Binary wire: "SFCF", version u8, channel 1..4 u8, mode u8, reserved u8, JPEG. */
export function encodeCameraFeedFrame(channel: Channel, mode: FeedMode, jpeg: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(CAMERA_FEED_HEADER_BYTES + jpeg.length);
  CAMERA_FEED_MAGIC.copy(frame, 0);
  frame[4] = CAMERA_FEED_VERSION;
  frame[5] = CHANNELS.indexOf(channel) + 1;
  frame[6] = MODE_CODE[mode];
  frame[7] = 0;
  jpeg.copy(frame, CAMERA_FEED_HEADER_BYTES);
  return frame;
}

/** Fans the newest frame per channel to each socket without queueing stale images. */
export class CameraFeedMultiplexer {
  private readonly clients = new Map<MultiplexSocket, {
    modesJson: string;
    revisions: Map<Channel, number>;
  }>();

  attach(socket: MultiplexSocket, modes: Readonly<Record<string, FeedMode>>): void {
    const modesJson = stateMessage(modes);
    this.clients.set(socket, { modesJson, revisions: new Map() });
    if (socket.readyState === WebSocket.OPEN) socket.send(modesJson);
    socket.on('close', () => this.clients.delete(socket));
  }

  push(frames: readonly MultiplexFrame[], modes: Readonly<Record<string, FeedMode>>): void {
    const modesJson = stateMessage(modes);
    const encoded = new Map<Channel, Buffer>();
    for (const [socket, client] of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) {
        this.clients.delete(socket);
        continue;
      }
      if (socket.bufferedAmount > WS_BACKPRESSURE_BYTES) continue;
      if (client.modesJson !== modesJson) {
        socket.send(modesJson);
        client.modesJson = modesJson;
      }
      for (const frame of frames) {
        if (socket.bufferedAmount > WS_BACKPRESSURE_BYTES) break;
        if (!frame.jpeg || client.revisions.get(frame.channel) === frame.revision) continue;
        let bytes = encoded.get(frame.channel);
        if (!bytes) {
          bytes = encodeCameraFeedFrame(frame.channel, frame.mode, frame.jpeg);
          encoded.set(frame.channel, bytes);
        }
        socket.send(bytes, { binary: true });
        client.revisions.set(frame.channel, frame.revision);
      }
    }
  }
}

function stateMessage(modes: Readonly<Record<string, FeedMode>>): string {
  return JSON.stringify({ type: 'camera_feed_states', states: modes });
}

export interface LiveFeedConfig {
  readonly streamPrefix: string;
  readonly region: string;
  readonly profile: string;
}

interface ChannelState {
  process: ChildProcessByStdio<null, Readable, null> | null;
  buffer: Buffer;
  latest: Buffer | null;
  revision: number;
  clients: Set<ServerResponse>;
  mode: FeedMode;
  targetMode: Exclude<FeedMode, 'starting'> | null;
  liveRetryTimer: NodeJS.Timeout | null;
}

const LIVE_RETRY_MS = 5 * 60 * 1000;
const HLS_EXPIRES_S = 43_200;

export class MjpegService {
  private readonly footage: string;
  private readonly fps: number;
  private readonly channels = new Map<Channel, ChannelState>();
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly multiplexer = new CameraFeedMultiplexer();
  private stopped = false;

  private readonly live: LiveFeedConfig | null;
  private readonly endpointCache = new Map<Channel, string>();

  constructor(footage: string, fps: number, live: LiveFeedConfig | null = null) {
    this.footage = footage;
    this.fps = fps;
    this.live = live;
  }

  /** Current per-channel feed mode (for twin_cameras + /health truthfulness). */
  modes(): Record<string, FeedMode> {
    const out: Record<string, FeedMode> = {};
    for (const [channel, state] of this.channels) out[channel] = state.mode;
    return out;
  }

  start(): void {
    for (const channel of CHANNELS) {
      const state: ChannelState = { process: null, buffer: Buffer.alloc(0), latest: null, revision: 0, clients: new Set(), mode: 'starting', targetMode: null, liveRetryTimer: null };
      this.channels.set(channel, state);
      void this.launch(channel, state);
    }
    this.pushTimer = setInterval(() => this.pushFrames(), 1000 / this.fps);
  }

  private awsCli(args: string[]): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    execFile('aws', args, { env: { ...process.env, AWS_PROFILE: this.live!.profile }, timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout.trim());
    });
    return promise;
  }

  /** Resolve a fresh KVS HLS session URL for the channel's live camera stream. */
  private async resolveHlsUrl(channel: Channel): Promise<string> {
    const { streamPrefix, region } = this.live!;
    const streamName = `${streamPrefix}${channel}`;
    let endpoint = this.endpointCache.get(channel);
    if (!endpoint) {
      endpoint = await this.awsCli(['kinesisvideo', 'get-data-endpoint', '--stream-name', streamName, '--api-name', 'GET_HLS_STREAMING_SESSION_URL', '--region', region, '--query', 'DataEndpoint', '--output', 'text']);
      this.endpointCache.set(channel, endpoint);
    }
    return this.awsCli(['kinesis-video-archived-media', 'get-hls-streaming-session-url', '--endpoint-url', endpoint, '--stream-name', streamName, '--playback-mode', 'LIVE', '--expires', String(HLS_EXPIRES_S), '--region', region, '--query', 'HLSStreamingSessionURL', '--output', 'text']);
  }

  private async launch(channel: Channel, state: ChannelState): Promise<void> {
    if (this.stopped) return;
    if (state.liveRetryTimer) {
      clearTimeout(state.liveRetryTimer);
      state.liveRetryTimer = null;
    }
    let args: string[];
    let targetMode: Exclude<FeedMode, 'starting'>;
    state.mode = 'starting';
    state.targetMode = null;
    state.latest = null;
    if (this.live) {
      try {
        const hlsUrl = await this.resolveHlsUrl(channel);
        args = ['-hide_banner', '-loglevel', 'error', '-i', hlsUrl, '-vf', 'scale=640:480', '-r', String(this.fps), '-q:v', '7', '-f', 'mjpeg', 'pipe:1'];
        targetMode = 'live';
      } catch (error) {
        console.warn(`[mjpeg] ${channel}: live feed unavailable (${String(error).slice(0, 120)}); falling back to recorded loop`);
        this.endpointCache.delete(channel);
        args = this.replayArgs(channel);
        targetMode = 'replay';
        state.liveRetryTimer = setTimeout(() => state.process?.kill('SIGTERM'), LIVE_RETRY_MS);
      }
    } else {
      args = this.replayArgs(channel);
      targetMode = 'replay';
    }
    state.targetMode = targetMode;
    if (this.stopped) return;
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    state.process = child;
    child.stdout.on('data', (chunk: Buffer) => {
      state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
      // Extract complete JPEGs (SOI..EOI), keep only the newest.
      for (;;) {
        const start = state.buffer.indexOf(SOI);
        if (start < 0) {
          state.buffer = Buffer.alloc(0);
          break;
        }
        const end = state.buffer.indexOf(EOI, start + 2);
        if (end < 0) {
          if (start > 0) state.buffer = state.buffer.subarray(start);
          break;
        }
        state.latest = state.buffer.subarray(start, end + 2);
        state.revision += 1;
        state.mode = state.targetMode ?? 'starting';
        state.buffer = state.buffer.subarray(end + 2);
      }
      // Bound memory if EOI never appears (corrupt stream).
      if (state.buffer.length > 8 * 1024 * 1024) state.buffer = Buffer.alloc(0);
    });
    child.on('exit', () => {
      state.latest = null;
      state.mode = 'starting';
      state.targetMode = null;
      state.process = null;
      if (!this.stopped) setTimeout(() => void this.launch(channel, state), 2000);
    });
  }

  private replayArgs(channel: Channel): string[] {
    return ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', this.footage, '-vf', CHANNEL_FILTER[channel], '-r', String(this.fps), '-q:v', '7', '-f', 'mjpeg', 'pipe:1'];
  }

  private pushFrames(): void {
    const multiplexFrames: MultiplexFrame[] = [];
    for (const [channel, state] of this.channels) {
      const frame = state.latest;
      multiplexFrames.push({ channel, mode: state.mode, jpeg: frame, revision: state.revision });
      if (!frame) continue;
      for (const res of state.clients) {
        if (res.writableEnded || res.destroyed) {
          state.clients.delete(res);
          continue;
        }
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write('\r\n');
      }
    }
    this.multiplexer.push(multiplexFrames, this.modes());
  }

  /** Attach an HTTP response as a multipart client. Returns false if unknown. */
  attach(channel: string, res: ServerResponse): boolean {
    const state = this.channels.get(channel as Channel);
    if (!state) return false;
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'close',
      'Access-Control-Allow-Origin': '*',
    });
    state.clients.add(res);
    res.on('close', () => state.clients.delete(res));
    return true;
  }

  /** Attach one WebSocket that receives every channel's newest JPEG. */
  attachMultiplex(socket: MultiplexSocket): void {
    this.multiplexer.attach(socket, this.modes());
  }

  stop(): void {
    this.stopped = true;
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
    for (const state of this.channels.values()) {
      clearTimeout(state.liveRetryTimer ?? undefined);
      state.process?.kill('SIGTERM');
      for (const res of state.clients) res.end();
      state.clients.clear();
    }
  }
}
