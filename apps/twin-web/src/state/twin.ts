import { useCallback, useEffect, useRef, useState } from 'react';
import { CAMERAS, type TwinCamera } from '../lib/cameras';
import { decodeTruthFrame, type TruthFrame, TruthFrameStream } from '../lib/truth';

/** The three canvas compositions of the single editor surface. */
export type CanvasMode = 'scene' | 'drive' | 'cameras';

export interface Alert { id: string; title: string; message: string; kind?: 'warn' | 'danger' }

export interface Zone {
  id: string;
  name: string;
  message: string;
  zone_kind: string;
  signal_type: string;
  polygon: [number, number][];
  color: string;
}

export const FIXTURE_FRAME: TruthFrame = {
  tick: 120, timeSec: 6, scene: { tick: 120, t: 6, actors: [
    { id: 'ego-fixture', kind: 'spawn', position: [-151, 0, -25], rotation: [0, 0, 0, 1], yawRad: 2.2, velocity: [7.4, 0, 4.2], acceleration: [0, 0, 0] },
    { id: 'mirror-ch2-104', kind: 'spawn', position: [-169, 0, -43], rotation: [0, 0, 0, 1], yawRad: .6, velocity: [2.1, 0, 1.1], acceleration: [0, 0, 0] },
    { id: 'pedestrian-7', kind: 'spawn', position: [-178, 0, -55], rotation: [0, 0, 0, 1], yawRad: 0, velocity: [.4, 0, 0], acceleration: [0, 0, 0] },
  ] }, signals: [{ signalId: '61', phase: 'green' }], actors: [
    { id: 'ego-fixture', class: 'car', dims: { l: 4.7, w: 1.85, h: 1.45 }, accel: { ax: 0, ay: 0 } },
    { id: 'mirror-ch2-104', class: 'truck', dims: { l: 6.8, w: 2.4, h: 2.8 }, accel: { ax: 0, ay: 0 } },
    { id: 'pedestrian-7', class: 'pedestrian', dims: { l: .5, w: .5, h: 1.75 }, accel: { ax: 0, ay: 0 } },
  ],
};

/** The /twin viewer socket: truth frames, replay clock, cameras and EVA alerts. */
export function useTwinSocket(fixtureMode: boolean) {
  const socketRef = useRef<WebSocket | null>(null);
  const [frames, setFrames] = useState<TruthFrame[]>([FIXTURE_FRAME]);
  const [connected, setConnected] = useState(false);
  const [clock, setClock] = useState(0);
  const [mode, setMode] = useState<'live' | 'replay'>('live');
  const [alerts, setAlerts] = useState<Alert[]>(fixtureMode ? [{ id: 'fixture-eva', title: 'EVA priority vehicle', message: 'Emergency vehicle approaching junction 61 from the south.' }] : []);
  const [telemetry, setTelemetry] = useState({ speed: 43, gear: 2 });
  const [cameras, setCameras] = useState<readonly TwinCamera[]>(CAMERAS);
  const streamRef = useRef(new TruthFrameStream());

  useEffect(() => {
    if (fixtureMode) {
      fetch('/truth-frame-sample.bin').then((response) => response.ok ? response.arrayBuffer() : Promise.reject()).then((buffer) => setFrames([decodeTruthFrame(new Uint8Array(buffer))])).catch(() => undefined);
      return;
    }
    const socket = new WebSocket(import.meta.env.VITE_TWIN_WS_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/twin`);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'twin_clock' && message.replay_clock) {
          const replayDate = new Date(message.replay_clock);
          setClock(replayDate.getUTCHours() * 3600 + replayDate.getUTCMinutes() * 60 + replayDate.getUTCSeconds());
        }
        if (message.type === 'twin_mode') setMode(message.mode);
        if (message.type === 'eva_alert') setAlerts((current) => [...current, { id: crypto.randomUUID(), title: message.title ?? 'EVA alert', message: message.message ?? 'Emergency vehicle activity' }]);
        if (message.type === 'telemetry') setTelemetry({ speed: Number(message.speed ?? 0), gear: Number(message.gear ?? 0) });
        if (message.type === 'twin_cameras' && Array.isArray(message.cameras)) {
          setCameras(message.cameras.map((camera: Partial<TwinCamera> & { id: TwinCamera['id']; feed_url?: string; stream_url?: string; feed_mode?: TwinCamera['feedMode'] }) => {
            const fallback = CAMERAS.find((candidate) => candidate.id === camera.id) ?? CAMERAS[0]!;
            const raw = camera.streamUrl ?? camera.feed_url ?? camera.stream_url ?? fallback.streamUrl;
            // Same-origin: strip any absolute feed URL down to its path so the
            // request goes through this page's origin (vite proxies /streams).
            const streamUrl = /^https?:/.test(raw) ? new URL(raw).pathname : raw;
            return { ...fallback, ...camera, streamUrl, feedMode: camera.feed_mode ?? fallback.feedMode };
          }));
        }
      } else {
        const decoded = streamRef.current.push(new Uint8Array(event.data));
        if (decoded.length) setFrames((current) => [...current, ...decoded].slice(-2));
      }
    };
    return () => socket.close();
  }, [fixtureMode]);

  const send = useCallback((message: object) => socketRef.current?.readyState === WebSocket.OPEN && socketRef.current.send(JSON.stringify(message)), []);
  return { frames, connected: fixtureMode || connected, clock, mode, alerts, telemetry, cameras, send, setClock, setMode };
}

/** Contract of the shared /drive socket: drive controls + world operations. */
export interface DriveSocket {
  active: boolean;
  egoActorId: string | null;
  telemetry: { speed: number; gear: number };
  transmit(message: object): void;
  /** Session-scoped operation: sends now if a session is live, else auto-starts one and queues. */
  sendOp(message: object): void;
  startSession(): void;
  endSession(): void;
  /** Operation outcomes worth showing the operator (rejections, partial spawns). */
  notices: readonly Alert[];
  dismissNotice(id: string): void;
}

/** One shared /drive socket for the whole app. Server semantics are session-scoped
 * (verbatim from the v1 bridge), so editor world operations auto-start a session
 * and queue until session_ready. */
export function useDriveSocket(fixtureMode: boolean): DriveSocket {
  const socketRef = useRef<WebSocket | null>(null);
  const [active, setActive] = useState(false);
  const [egoActorId, setEgoActorId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState({ speed: 0, gear: 0 });
  const [notices, setNotices] = useState<Alert[]>([]);
  const notify = useCallback((title: string, message: string, kind: Alert['kind'] = 'danger') => {
    setNotices((current) => [...current.slice(-3), { id: crypto.randomUUID(), title, message, kind }]);
  }, []);
  const pendingRef = useRef<object[]>([]);
  const startedRef = useRef(false);
  const activeRef = useRef(false);

  const transmit = useCallback((message: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (fixtureMode) return;
    const socket = new WebSocket(import.meta.env.VITE_DRIVE_WS_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/drive`);
    socketRef.current = socket;
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.type === 'telemetry') setTelemetry({ speed: Number(message.speed ?? 0), gear: Number(message.gear ?? 0) });
      if (message.type === 'session_ready') {
        activeRef.current = true; setActive(true); setEgoActorId(String(message.vehicle_id));
        for (const queued of pendingRef.current.splice(0)) socket.send(JSON.stringify(queued));
      }
      if (message.type === 'respawned' || message.type === 'teleported') setEgoActorId(String(message.vehicle_id));
      if (message.type === 'session_ended') { activeRef.current = false; startedRef.current = false; setActive(false); setEgoActorId(null); }
      // Operations must never fail silently: the editor surfaces every rejection
      // and partial spawn as a notice instead of dropping it into the console.
      if (message.type === 'error') notify('Operation rejected', String(message.message ?? 'The server rejected the request'));
      if (message.type === 'scenario_loaded' && Number(message.failed ?? 0) > 0) {
        const failures = Array.isArray(message.failures) ? message.failures as Array<{ role?: string; reason?: string }> : [];
        const detail = failures.map((f) => `${f.role ?? 'actor'}: ${f.reason ?? 'spawn failed'}`).join('; ');
        notify(
          Number(message.spawned ?? 0) > 0 ? 'Scenario partially placed' : 'Scenario not placed',
          detail || `${message.failed} actor(s) could not spawn`,
          Number(message.spawned ?? 0) > 0 ? 'warn' : 'danger',
        );
      }
      if (message.type === 'undo_empty') notify('Nothing to undo', String(message.message ?? 'No placed objects'), 'warn');
    };
    socket.onclose = () => { activeRef.current = false; startedRef.current = false; setActive(false); setEgoActorId(null); };
    return () => socket.close();
  }, [fixtureMode, notify]);

  const startSession = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const end = new Date();
    transmit({ type: 'start_session', start: new Date(end.getTime() - 3_600_000).toISOString(), end: end.toISOString(), vehicle: 'vehicle.sedan' });
  }, [transmit]);

  /** Session-scoped operation: sends now if a session is live, else auto-starts one and queues. */
  const sendOp = useCallback((message: object) => {
    if (activeRef.current) { transmit(message); return; }
    pendingRef.current.push(message);
    startSession();
  }, [transmit, startSession]);

  const endSession = useCallback(() => transmit({ type: 'end_session' }), [transmit]);
  const dismissNotice = useCallback((id: string) => setNotices((current) => current.filter((n) => n.id !== id)), []);

  return { active, egoActorId, telemetry, transmit, sendOp, startSession, endSession, notices, dismissNotice };
}
