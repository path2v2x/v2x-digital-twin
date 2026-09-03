/**
 * Wire layer: WebSocket :8765 (/drive, /twin) + HTTP :8090 (MJPEG feeds,
 * /health). Every WS connection gets the shared world's binary truth_frame
 * relay; JSON control is per-path.
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { TwinConfig } from './config.js';
import { DriveSession, type DriveDeps } from './drive.js';
import { MjpegService } from './mjpeg.js';
import { TwinConnection } from './twin.js';

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(payload));
}

function requiredEpochMs(url: URL, name: string): number {
  const raw = url.searchParams.get(name);
  const value = raw === null ? Number.NaN : Date.parse(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an ISO timestamp`);
  return value;
}

const WS_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

export interface TwinServers {
  readonly wsServer: http.Server;
  readonly httpServer: http.Server;
  readonly mjpeg: MjpegService;
  close(): Promise<void>;
}

export function startServers(deps: DriveDeps): TwinServers {
  const { world, config, sync } = deps;

  /* ------------------------------------------------------------ WS :8765 */
  const wsHttp = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'WebSocket only: /drive or /twin' }));
  });
  const wss = new WebSocketServer({ server: wsHttp, maxPayload: 16 * 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname;
    const host = (req.headers.host ?? `localhost:${config.wsPort}`).split(':')[0] ?? 'localhost';

    if (route === '/camera-feeds') {
      mjpeg.attachMultiplex(ws);
      return;
    }

    // Binary truth_frame relay: verbatim engine bytes for every path.
    const unsubscribe = world.subscribe((bytes) => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > WS_BACKPRESSURE_BYTES) return;
      ws.send(bytes, { binary: true });
    });

    if (route === '/twin') {
      const twin = new TwinConnection(world, sync, config, url.searchParams);
      for (const message of twin.helloMessages(host, mjpeg.modes())) ws.send(JSON.stringify(message));
      let lastClockAt = 0;
      const clockTimer = setInterval(() => {
        const now = Date.now();
        if (ws.readyState !== WebSocket.OPEN) return;
        if (sync.currentMode() === 'live' && now - lastClockAt < 1000) return;
        lastClockAt = now;
        ws.send(JSON.stringify(twin.clockPayload()));
      }, 250);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        ws.send(JSON.stringify(twin.handle(data.toString())));
      });
      ws.on('close', () => {
        clearInterval(clockTimer);
        twin.dispose();
        unsubscribe();
      });
      return;
    }

    // Default route (and explicit /drive): drive protocol.
    const session = new DriveSession(deps);
    let queue = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      queue = queue.then(async () => {
        let parsed: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(raw);
          if (!value || typeof value !== 'object') throw new Error('not an object');
          parsed = value as Record<string, unknown>;
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          return;
        }
        const response = await session.handle(parsed);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
      });
    });
    ws.on('close', () => {
      session.dispose();
      unsubscribe();
    });
  });

  wsHttp.listen(config.wsPort, () => {
    console.log(`[twin-server] WS listening on :${config.wsPort} (/drive, /twin, /camera-feeds)`);
  });

  /* ---------------------------------------------------------- HTTP :8090 */
  const mjpeg = new MjpegService(
    config.footageMp4,
    config.mjpegFps,
    config.liveFeeds ? { urlTemplate: config.cameraUrlTemplate } : null,
  );
  mjpeg.start();
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const streamMatch = /^\/streams\/(ch\d+)\.mjpg$/.exec(url.pathname);
    if (streamMatch) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!mjpeg.attach(streamMatch[1]!, res)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown camera ${streamMatch[1]}` }));
      }
      return;
    }
    if (url.pathname === '/detections/coverage' || url.pathname === '/detections/history') {
      if (!sync.history) {
        jsonResponse(res, 503, { error: 'Detection history unavailable' });
        return;
      }
      try {
        const startMs = requiredEpochMs(url, 'start');
        const endMs = requiredEpochMs(url, 'end');
        if (endMs <= startMs) throw new Error('end must be after start');
        if (url.pathname === '/detections/coverage') {
          const rawBucket = url.searchParams.get('bucket');
          const bucketSec = rawBucket === null ? 300 : Number(rawBucket);
          if (!Number.isInteger(bucketSec) || bucketSec < 10) {
            throw new Error('bucket must be an integer of at least 10 seconds');
          }
          const bucketCount = Math.ceil((endMs - startMs) / (bucketSec * 1000));
          if (bucketCount > 2000) throw new Error('requested range exceeds 2000 buckets');
          jsonResponse(res, 200, {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            bucket_seconds: bucketSec,
            buckets: sync.history.coverage(startMs, endMs, bucketSec),
          });
          return;
        }
        const rawLimit = url.searchParams.get('limit');
        const requestedLimit = rawLimit === null ? 1000 : Number(rawLimit);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
          throw new Error('limit must be a positive integer');
        }
        jsonResponse(res, 200, sync.history.range(startMs, endMs, Math.min(requestedLimit, 5000)));
      } catch (error) {
        jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (url.pathname === '/health') {
      jsonResponse(res, 200, { status: 'ok', engine: 'simforge-oss', mode: sync.currentMode(), feeds: mjpeg.modes() });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  httpServer.listen(config.httpPort, () => {
    console.log(`[twin-server] HTTP listening on :${config.httpPort} (/streams/ch1..4.mjpg, /detections/*, /health)`);
  });

  return {
    wsServer: wsHttp,
    httpServer,
    mjpeg,
    close(): Promise<void> {
      const { promise, resolve } = Promise.withResolvers<void>();
      mjpeg.stop();
      for (const client of wss.clients) client.terminate();
      wss.close();
      let pending = 2;
      const done = () => {
        pending -= 1;
        if (pending === 0) resolve();
      };
      wsHttp.close(done);
      httpServer.close(done);
      return promise;
    },
  };
}
