/**
 * MJPEG camera feeds from one local stream per channel, with recorded footage
 * as a fallback. TWIN_CAMERA_URL_TEMPLATE supplies the ffmpeg input URL and
 * substitutes `{channel}` with ch1..ch4. RTSP inputs use TCP transport.
 *
 * TWIN_CAMERA_SOCKET_PATH, when set, replaces the ffmpeg/RTSP live path
 * entirely: frames are read directly off co-perception's own Unix-socket
 * broadcast (see co_perception/common/broadcast.py for the wire format),
 * one connection shared across all four channels, no ffmpeg, no RTSP, no
 * MediaMTX involved. This is intentionally independent of the recording
 * pipeline (which still runs its own separate relay into MediaMTX) -- the
 * live display and the 72h archive no longer share any component.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import net from 'node:net';
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
  send(data: Buffer | string): void;
  send(data: Buffer, options: { binary?: boolean }): void;
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
  readonly urlTemplate: string;
  /** When set, live frames come directly from co-perception's broadcast
   * socket instead of ffmpeg/RTSP -- urlTemplate is then unused for the
   * live path (replay fallback still uses ffmpeg on recorded footage). */
  readonly directSocketPath?: string;
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
  liveUnavailableUntil: number;
  /** Consecutive live launches that exited without ever producing a frame. */
  liveFailures: number;
}

/**
 * Live input retry: 10 s after a live run that had produced frames (an upstream
 * camera blip; the relay republishes within seconds), doubling per consecutive
 * frameless failure up to 2 min so a dead source does not spin ffmpeg.
 */
const LIVE_RETRY_BASE_MS = 10_000;
const LIVE_RETRY_MAX_MS = 120_000;

/** Reconnect delay for the direct co-perception socket (no ffmpeg process
 * lifecycle to key off, so this is just a fixed short backoff). */
const DIRECT_SOCKET_RECONNECT_MS = 2_000;

/** Wire format, see co_perception/common/broadcast.py: 1-byte msg_type,
 * 4-byte big-endian payload length, then the payload. */
const DIRECT_SOCKET_HEADER_BYTES = 5;
const MSG_ANNOTATED_FRAME = 1;

export class MjpegService {
  private readonly footage: string;
  private readonly fps: number;
  private readonly channels = new Map<Channel, ChannelState>();
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly multiplexer = new CameraFeedMultiplexer();
  private stopped = false;

  private readonly live: LiveFeedConfig | null;

  private directSocket: net.Socket | null = null;
  private directSocketBuffer: Buffer = Buffer.alloc(0);
  private directSocketRetryTimer: NodeJS.Timeout | null = null;

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
    const useDirectSocket = Boolean(this.live?.directSocketPath);
    for (const channel of CHANNELS) {
      const state: ChannelState = { process: null, buffer: Buffer.alloc(0), latest: null, revision: 0, clients: new Set(), mode: 'starting', targetMode: null, liveRetryTimer: null, liveUnavailableUntil: 0, liveFailures: 0 };
      this.channels.set(channel, state);
      // Direct-socket mode: frames arrive out-of-band via connectDirectSocket
      // below, shared across all four channels -- no per-channel process.
      if (!useDirectSocket) void this.launch(channel, state);
    }
    if (useDirectSocket) {
      console.log(`[twin-server] mjpeg: live feed source is co-perception socket ${this.live!.directSocketPath} (no ffmpeg, no RTSP, no MediaMTX)`);
      this.connectDirectSocket(this.live!.directSocketPath!);
    }
    this.pushTimer = setInterval(() => this.pushFrames(), 1000 / this.fps);
  }

  private connectDirectSocket(socketPath: string): void {
    if (this.stopped) return;
    this.directSocketBuffer = Buffer.alloc(0);
    const sock = net.createConnection({ path: socketPath });
    this.directSocket = sock;

    sock.on('connect', () => {
      console.log(`[twin-server] mjpeg: connected to co-perception socket ${socketPath}`);
    });

    sock.on('data', (chunk: Buffer) => {
      this.directSocketBuffer = this.directSocketBuffer.length === 0 ? chunk : Buffer.concat([this.directSocketBuffer, chunk]);
      this.drainDirectSocketBuffer();
    });

    sock.on('error', (err: Error) => {
      console.warn(`[twin-server] mjpeg: co-perception socket error: ${err.message}`);
    });

    sock.on('close', () => {
      if (this.stopped) return;
      this.directSocket = null;
      if (this.directSocketRetryTimer) clearTimeout(this.directSocketRetryTimer);
      this.directSocketRetryTimer = setTimeout(() => this.connectDirectSocket(socketPath), DIRECT_SOCKET_RECONNECT_MS);
    });
  }

  /** Annotated frames (msg_type 1) carry a 1-byte channel index (0..3) then
   * raw JPEG bytes. Other message types on this socket (raw frames,
   * detections JSON) are present but not relevant to the live display, so
   * they're skipped. A dropped/paused co-perception tick simply means no
   * new message arrives -- the last frame stays on screen, frozen, rather
   * than the feed disconnecting. */
  private drainDirectSocketBuffer(): void {
    for (;;) {
      if (this.directSocketBuffer.length < DIRECT_SOCKET_HEADER_BYTES) return;
      const msgType = this.directSocketBuffer.readUInt8(0);
      const payloadLen = this.directSocketBuffer.readUInt32BE(1);
      const totalLen = DIRECT_SOCKET_HEADER_BYTES + payloadLen;
      if (this.directSocketBuffer.length < totalLen) return;
      const payload = this.directSocketBuffer.subarray(DIRECT_SOCKET_HEADER_BYTES, totalLen);
      this.directSocketBuffer = this.directSocketBuffer.subarray(totalLen);

      if (msgType === MSG_ANNOTATED_FRAME && payload.length >= 1) {
        const channel = CHANNELS[payload.readUInt8(0)];
        const jpeg = payload.subarray(1);
        const state = channel ? this.channels.get(channel) : undefined;
        if (state) {
          state.latest = jpeg;
          state.revision += 1;
          state.mode = 'live';
        }
      }
    }
  }

  private launch(channel: Channel, state: ChannelState): void {
    if (this.stopped) return;
    if (state.liveRetryTimer) {
      clearTimeout(state.liveRetryTimer);
      state.liveRetryTimer = null;
    }
    state.mode = 'starting';
    state.targetMode = null;
    state.latest = null;

    let args: string[];
    let targetMode: Exclude<FeedMode, 'starting'>;
    if (this.live && Date.now() >= state.liveUnavailableUntil) {
      const inputUrl = this.live.urlTemplate.replaceAll('{channel}', channel);
      const transport = inputUrl.toLowerCase().startsWith('rtsp://') ? ['-rtsp_transport', 'tcp'] : [];
      args = ['-hide_banner', '-loglevel', 'error', ...transport, '-i', inputUrl, '-vf', 'scale=640:480', '-r', String(this.fps), '-q:v', '7', '-f', 'mjpeg', 'pipe:1'];
      targetMode = 'live';
    } else {
      args = this.replayArgs(channel);
      targetMode = 'replay';
      if (this.live) {
        const delay = Math.max(1, state.liveUnavailableUntil - Date.now());
        state.liveRetryTimer = setTimeout(() => state.process?.kill('SIGTERM'), delay);
      }
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
        if (state.mode === 'live') state.liveFailures = 0;
        state.buffer = state.buffer.subarray(end + 2);
      }
      // Bound memory if EOI never appears (corrupt stream).
      if (state.buffer.length > 8 * 1024 * 1024) state.buffer = Buffer.alloc(0);
    });
    child.on('exit', () => {
      if (targetMode === 'live') {
        const producedFrames = state.mode === 'live';
        if (!producedFrames) state.liveFailures += 1;
        state.liveUnavailableUntil = Date.now() + Math.min(LIVE_RETRY_BASE_MS * 2 ** state.liveFailures, LIVE_RETRY_MAX_MS);
      }
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
    if (this.directSocketRetryTimer) {
      clearTimeout(this.directSocketRetryTimer);
      this.directSocketRetryTimer = null;
    }
    if (this.directSocket) {
      this.directSocket.destroy();
      this.directSocket = null;
    }
    for (const state of this.channels.values()) {
      clearTimeout(state.liveRetryTimer ?? undefined);
      state.process?.kill('SIGTERM');
      for (const res of state.clients) res.end();
      state.clients.clear();
    }
  }
}
