import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TwinScene } from './components/TwinScene';
import { CAMERAS, type TwinCamera } from './lib/cameras';
import { decodeTruthFrame, type TruthFrame, type TruthActor, TruthFrameStream } from './lib/truth';
import { sceneToWgs84 } from './lib/coordinates';

const FIXTURE_FRAME: TruthFrame = {
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

type Page = 'map' | 'cameras' | 'drive';
interface Zone { id: string; name: string; message: string; zone_kind: string; signal_type: string; polygon: [number, number][]; color: string }
interface Alert { id: string; title: string; message: string }

function useTwinSocket(fixtureMode: boolean) {
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
          setCameras(message.cameras.map((camera: Partial<TwinCamera> & { id: TwinCamera['id']; feed_url?: string; stream_url?: string }) => {
            const fallback = CAMERAS.find((candidate) => candidate.id === camera.id) ?? CAMERAS[0]!;
            const raw = camera.streamUrl ?? camera.feed_url ?? camera.stream_url ?? fallback.streamUrl;
            // Same-origin: strip any absolute feed URL down to its path so the
            // request goes through this page's origin (vite proxies /streams).
            const streamUrl = /^https?:/.test(raw) ? new URL(raw).pathname : raw;
            return { ...fallback, ...camera, streamUrl };
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

function CameraPage({ frames, cameras }: { frames: readonly TruthFrame[]; cameras: readonly TwinCamera[] }) {
  return <main className="camera-grid" aria-label="Calibrated real and digital camera comparisons">
    {cameras.map((camera) => <article className="camera-card" key={camera.id} data-testid={`camera-${camera.id}`}>
      <header><strong>{camera.id.toUpperCase()}</strong><span>CALIBRATED · 2560 × 1920</span></header>
      <div className="comparison">
        <figure><div className="feed-wrap"><img src={camera.streamUrl} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = '/fixture-camera.jpg'; }} alt={`${camera.id} real MJPEG stream`} /><span className="live-badge">● REAL · LIVE</span></div><figcaption>Site camera</figcaption></figure>
        <figure><div className="feed-wrap twin-feed"><TwinScene frames={frames} camera={camera} /><span className="twin-badge">SIMFORGE · TRUTH</span></div><figcaption>Projection-matched digital twin</figcaption></figure>
      </div>
    </article>)}
  </main>;
}

function ZoneEditor({ send }: { send(message: object): void }) {
  const [drawing, setDrawing] = useState(false);
  const [vertices, setVertices] = useState<[number, number][]>([]);
  const [zones, setZones] = useState<Zone[]>(() => JSON.parse(localStorage.getItem('v2x-zones') ?? '[]'));
  const complete = () => {
    if (vertices.length < 3) return;
    const zone: Zone = { id: crypto.randomUUID(), name: `Zone ${zones.length + 1}`, message: 'Connected vehicle advisory', zone_kind: 'advisory', signal_type: 'v2x', polygon: vertices, color: '#24e6ff' };
    const next = [...zones, zone]; setZones(next); setVertices([]); setDrawing(false); localStorage.setItem('v2x-zones', JSON.stringify(next)); send({ type: 'sync_v2x_zones', zones: next });
  };
  return <div className="zone-tools"><button onClick={() => setDrawing(!drawing)} className={drawing ? 'active' : ''}>{drawing ? 'Click map to draw' : 'Draw V2X zone'}</button>{drawing && <button onClick={complete} disabled={vertices.length < 3}>Save polygon ({vertices.length})</button>}<span>{zones.length} saved</span>{drawing && <div className="draw-capture" onClick={(event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = -130 + ((event.clientX - bounds.left) / bounds.width - .5) * 300;
    const z = -57 + ((event.clientY - bounds.top) / bounds.height - .5) * 300;
    const point = sceneToWgs84([x, 0, z]); setVertices((current) => [...current, [point.lon, point.lat]]);
  }}><span>DRAWING · {vertices.length} VERTICES</span></div>}</div>;
}

const WEATHER_PRESETS: Record<string, Record<string, number>> = {
  clear: { cloudiness: 10, precipitation: 0, fog_density: 0, sun_altitude_angle: 75 },
  overcast: { cloudiness: 85, precipitation: 0, fog_density: 0, sun_altitude_angle: 45 },
  rain: { cloudiness: 90, precipitation: 80, precipitation_deposits: 60, fog_density: 0, sun_altitude_angle: 35 },
  fog: { cloudiness: 60, precipitation: 0, fog_density: 40, fog_distance: 20, sun_altitude_angle: 25 },
};

/** Contract of the shared /drive socket: drive-page controls + map-page world operations. */
export interface DriveSocket {
  active: boolean;
  egoActorId: string | null;
  telemetry: { speed: number; gear: number };
  transmit(message: object): void;
  /** Session-scoped operation: sends now if a session is live, else auto-starts one and queues. */
  sendOp(message: object): void;
  startSession(): void;
  endSession(): void;
}

/** One shared /drive socket for the whole app. Server semantics are session-scoped
 * (verbatim from the v1 bridge), so map-page operations auto-start a session and
 * queue until session_ready. */
function useDriveSocket(fixtureMode: boolean): DriveSocket {
  const socketRef = useRef<WebSocket | null>(null);
  const [active, setActive] = useState(false);
  const [egoActorId, setEgoActorId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState({ speed: 0, gear: 0 });
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
      if (message.type === 'error') console.warn('[drive]', message.message);
    };
    socket.onclose = () => { activeRef.current = false; startedRef.current = false; setActive(false); setEgoActorId(null); };
    return () => socket.close();
  }, [fixtureMode]);

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

  return { active, egoActorId, telemetry, transmit, sendOp, startSession, endSession };
}


function OperationsPanel({ send }: { send(message: object): void }) {
  const [weather, setWeather] = useState('clear');
  const [traffic, setTraffic] = useState('medium');
  return <aside className="operations-panel">
    <h2>World controls</h2>
    <label>Weather<select value={weather} onChange={(event) => { setWeather(event.target.value); send({ type: 'set_weather', params: WEATHER_PRESETS[event.target.value] ?? WEATHER_PRESETS['clear'] }); }}><option>clear</option><option>overcast</option><option>rain</option><option>fog</option></select></label>
    <label>Ambient traffic<select value={traffic} onChange={(event) => { setTraffic(event.target.value); send({ type: 'spawn_traffic', preset: event.target.value }); }}><option>none</option><option>light</option><option>medium</option><option>heavy</option><option>chaos</option></select></label>
    <button onClick={() => send({ type: 'load_scenario', file: 'firetruck-from-north.template.json' })}>Place firetruck scenario</button>
    <button onClick={() => send({ type: 'spawn_object', blueprint: 'vehicle.tesla.model3' })}>Place vehicle</button>
    <button onClick={() => send({ type: 'start_trajectory', file: 'event1.json', vehicle: 'vehicle.tesla.model3' })}>Play GPS trajectory</button>
  </aside>;
}

function DrivePage({ frames, fixtureMode, drive }: { frames: readonly TruthFrame[]; fixtureMode: boolean; drive: DriveSocket }) {
  const [fixtureActive, setFixtureActive] = useState(false);
  const [cameraMode, setCameraMode] = useState<'chase' | 'first-person'>('chase');
  const keys = useRef(new Set<string>());
  const active = fixtureMode ? fixtureActive : drive.active;
  const telemetry = fixtureMode ? { speed: 43, gear: 2 } : drive.telemetry;
  const { transmit } = drive;

  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(event.key.toLowerCase())) { keys.current.add(event.key.toLowerCase()); event.preventDefault(); } };
    const up = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase());
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    const loop = window.setInterval(() => {
      if (!active || fixtureMode) return;
      const held = keys.current;
      transmit({ type: 'control', s: (held.has('a') || held.has('arrowleft') ? -1 : 0) + (held.has('d') || held.has('arrowright') ? 1 : 0), t: held.has('w') || held.has('arrowup') ? 1 : 0, b: held.has('s') || held.has('arrowdown') ? 1 : 0, r: false });
    }, 50);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); clearInterval(loop); };
  }, [active, fixtureMode, transmit]);
  const fixtureEgoId = frames.at(-1)?.actors.find((actor) => actor.id.includes('ego'))?.id ?? frames.at(-1)?.actors[0]?.id ?? null;
  return <main className="drive-page"><TwinScene frames={frames} followActorId={drive.egoActorId ?? fixtureEgoId} cameraMode={cameraMode} /><div className="drive-hud">
    <div className="mode-label">DRIVING MODE <span>{active ? 'SESSION ACTIVE' : fixtureMode ? 'FIXTURE READY' : 'SESSION READY'}</span></div><div className="speed"><strong>{Math.round(telemetry.speed)}</strong><span>km/h</span></div><div className="gear">GEAR {telemetry.gear}</div>
    <div className="drive-actions"><button className={active ? 'danger' : 'primary'} onClick={() => {
      if (fixtureMode) setFixtureActive(!fixtureActive);
      else if (drive.active) drive.endSession();
      else drive.startSession();
    }}>{active ? 'End session' : 'Start drive session'}</button><button onClick={() => setCameraMode(cameraMode === 'chase' ? 'first-person' : 'chase')}>{cameraMode === 'chase' ? 'Chase camera' : 'First-person camera'}</button></div>
    <div className="key-hint"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows to drive</div>
  </div></main>;
}

export default function App() {
  const fixtureMode = new URLSearchParams(location.search).get('fixture') === '1';
  const twin = useTwinSocket(fixtureMode);
  const drive = useDriveSocket(fixtureMode);
  const requestedPage = new URLSearchParams(location.search).get('page');
  const [page, setPage] = useState<Page>(requestedPage === 'map' || requestedPage === 'drive' ? requestedPage : 'cameras');
  const [selectedActor, setSelectedActor] = useState<TruthActor | null>(null);
  const actorList = twin.frames.at(-1)?.actors ?? [];
  const timestamp = useMemo(() => new Date(twin.clock * 1000).toISOString().slice(11, 19), [twin.clock]);
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">SF</span><div><strong>Richmond V2X Twin</strong><small>SimForge · truth synchronized</small></div></div><nav>{(['map','cameras','drive'] as Page[]).map((item) => <button key={item} className={page === item ? 'active' : ''} onClick={() => setPage(item)}>{item === 'cameras' ? 'Cameras · 4' : item}</button>)}</nav><div className="connection"><i className={twin.connected ? 'online' : ''}/>{fixtureMode ? 'FIXTURE REPLAY' : twin.connected ? 'CONNECTED' : 'OFFLINE'}</div></header>
    <section className="replay-bar"><button className={twin.mode === 'live' ? 'active' : ''} onClick={() => { twin.setMode('live'); twin.send({ type: 'twin_live' }); }}>Live</button><button className={twin.mode === 'replay' ? 'active' : ''} onClick={() => {
      twin.setMode('replay');
      const start = new Date(); start.setUTCHours(0, 0, twin.clock, 0);
      twin.send({ type: 'twin_replay', start: start.toISOString(), speed: 1 });
    }}>Replay</button><input aria-label="Replay clock" type="range" min="0" max="86400" step="1" value={twin.clock} onChange={(event) => {
      const value = Number(event.target.value); twin.setClock(value);
      const start = new Date(); start.setUTCHours(0, 0, value, 0);
      twin.send({ type: 'twin_replay', start: start.toISOString(), speed: 1 });
    }} /><time>{timestamp}</time></section>
    {page === 'cameras' && <CameraPage frames={twin.frames} cameras={twin.cameras}/>}
    {page === 'drive' && <DrivePage frames={twin.frames} fixtureMode={fixtureMode} drive={drive}/>}
    {page === 'map' && <main className="map-page"><TwinScene frames={twin.frames}/><ZoneEditor send={drive.sendOp}/><OperationsPanel send={drive.sendOp}/><aside className="objects-panel"><h2>Truth objects</h2>{actorList.map((actor) => <button key={actor.id} onClick={() => setSelectedActor(actor)}><span>{actor.class}</span>{actor.id}</button>)}</aside>{selectedActor && <aside className="detail-panel"><button onClick={() => setSelectedActor(null)}>×</button><small>OBJECT DETAIL</small><h2>{selectedActor.id}</h2><dl><dt>Class</dt><dd>{selectedActor.class}</dd><dt>Dimensions</dt><dd>{selectedActor.dims.l} × {selectedActor.dims.w} × {selectedActor.dims.h} m</dd><dt>Source</dt><dd>{/mirror|ghost/.test(selectedActor.id) ? 'Mirrored V2X detection' : 'SimForge truth'}</dd></dl></aside>}</main>}
    <aside className="alerts"><h2>EVA alerts <span>{twin.alerts.length}</span></h2>{twin.alerts.map((alert) => <article key={alert.id}><strong>{alert.title}</strong><p>{alert.message}</p></article>)}</aside>
  </div>;
}
