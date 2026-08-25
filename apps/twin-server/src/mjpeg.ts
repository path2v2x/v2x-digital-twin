/**
 * MJPEG camera feeds: GET /streams/ch{1..4}.mjpg — multipart JPEG streaming
 * the recorded site footage on loop (perception-app URL shape). One ffmpeg
 * per channel decodes the mp4 with -stream_loop -1 into an MJPEG pipe; a
 * per-channel crop/offset makes the four cells visibly distinct. The HTTP
 * layer holds only the latest JPEG per channel and writes it to every
 * connected client at the configured fps.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';

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

interface ChannelState {
  process: ChildProcessByStdio<null, Readable, null> | null;
  buffer: Buffer;
  latest: Buffer | null;
  clients: Set<ServerResponse>;
}

export class MjpegService {
  private readonly footage: string;
  private readonly fps: number;
  private readonly channels = new Map<Channel, ChannelState>();
  private pushTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(footage: string, fps: number) {
    this.footage = footage;
    this.fps = fps;
  }

  start(): void {
    for (const channel of CHANNELS) {
      const state: ChannelState = { process: null, buffer: Buffer.alloc(0), latest: null, clients: new Set() };
      this.channels.set(channel, state);
      this.launch(channel, state);
    }
    this.pushTimer = setInterval(() => this.pushFrames(), 1000 / this.fps);
  }

  private launch(channel: Channel, state: ChannelState): void {
    if (this.stopped) return;
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-re', '-stream_loop', '-1', '-i', this.footage,
        '-vf', CHANNEL_FILTER[channel],
        '-r', String(this.fps),
        '-q:v', '7',
        '-f', 'mjpeg', 'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
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
        state.buffer = state.buffer.subarray(end + 2);
      }
      // Bound memory if EOI never appears (corrupt stream).
      if (state.buffer.length > 8 * 1024 * 1024) state.buffer = Buffer.alloc(0);
    });
    child.on('exit', () => {
      state.process = null;
      if (!this.stopped) setTimeout(() => this.launch(channel, state), 2000);
    });
  }

  private pushFrames(): void {
    for (const state of this.channels.values()) {
      const frame = state.latest;
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

  stop(): void {
    this.stopped = true;
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
    for (const state of this.channels.values()) {
      state.process?.kill('SIGTERM');
      for (const res of state.clients) res.end();
      state.clients.clear();
    }
  }
}
