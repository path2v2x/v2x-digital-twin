import { CloseIcon, TargetIcon, TrafficIcon, WeatherIcon } from './icons';
import type { WorldTool } from './ToolRail';
import { TRAFFIC_PRESETS, WEATHER_PRESETS } from '../../state/catalog';
import type { SceneActor, TruthActor } from '../../lib/truth';

interface InspectorProps {
  actor: TruthActor | null;
  sceneActor: SceneActor | null;
  world: WorldTool | null;
  onClose(): void;
  weather: string;
  onWeather(preset: string): void;
  traffic: string;
  onTraffic(preset: string): void;
}

/** A floating panel, mounted on demand. A selected truth object wins over the
 * world controls: you asked about that object, so that is what it answers. */
export function Inspector({ actor, sceneActor, world, onClose, weather, onWeather, traffic, onTraffic }: InspectorProps) {
  if (actor) return <ObjectDetail actor={actor} sceneActor={sceneActor} onClose={onClose} />;
  if (world) return <WorldControls world={world} onClose={onClose} weather={weather} onWeather={onWeather} traffic={traffic} onTraffic={onTraffic} />;
  return null;
}

function ObjectDetail({ actor, sceneActor, onClose }: { actor: TruthActor; sceneActor: SceneActor | null; onClose(): void }) {
  /* Scene velocity is metres per second in world axes; the top-down plane is
   * x/z, so the ground speed is the hypotenuse of those two. (Drive telemetry
   * is a different quantity — the server already sends that one in km/h.) */
  const speedKmh = sceneActor ? Math.hypot(sceneActor.velocity[0], sceneActor.velocity[2]) * 3.6 : null;
  return <aside className="panel panel--right" aria-label="Object inspector" data-testid="twin-inspector">
    <header className="panel__head">
      <span className="panel__icon" aria-hidden><TargetIcon /></span>
      <span className="truncate">
        <span className="panel__title truncate" title={actor.id}>{actor.id}</span>
        <span className="panel__sub">Truth object</span>
      </span>
      <button type="button" className="icon-btn panel__close" aria-label="Clear selection" onClick={onClose}><CloseIcon /></button>
    </header>
    <div className="panel__body scroll">
      <Field label="Class" value={actor.class} />
      <Field label="Speed" value={speedKmh === null ? 'no pose' : `${speedKmh.toFixed(1)} km/h`} />
      <Field label="Dimensions" value={`${actor.dims.l} × ${actor.dims.w} × ${actor.dims.h} m`} />
      <Field label="Position" value={sceneActor ? `${sceneActor.position[0].toFixed(1)}, ${sceneActor.position[2].toFixed(1)}` : 'no pose'} hint="scene x, z" />
      <Field label="Heading" value={sceneActor ? `${(sceneActor.yawRad * 180 / Math.PI).toFixed(1)}°` : 'no pose'} />
      <Field label="Source" value={/mirror|ghost/.test(actor.id) ? 'Mirrored V2X detection' : 'SimForge truth'} />
    </div>
  </aside>;
}

function WorldControls({ world, onClose, weather, onWeather, traffic, onTraffic }: {
  world: WorldTool;
  onClose(): void;
  weather: string;
  onWeather(preset: string): void;
  traffic: string;
  onTraffic(preset: string): void;
}) {
  const isWeather = world === 'weather';
  return <aside className="panel panel--right" aria-label={isWeather ? 'Weather' : 'Ambient traffic'} data-testid="twin-world-panel">
    <header className="panel__head">
      <span className="panel__icon" aria-hidden>{isWeather ? <WeatherIcon /> : <TrafficIcon />}</span>
      <span>
        <span className="panel__title">{isWeather ? 'Weather' : 'Ambient traffic'}</span>
        <span className="panel__sub">World</span>
      </span>
      <button type="button" className="icon-btn panel__close" aria-label="Close panel" onClick={onClose}><CloseIcon /></button>
    </header>
    <div className="panel__body scroll">
      {isWeather
        ? <>
          <p className="panel__lede">Applies immediately to the running server. Presets set cloud, precipitation and sun angle together.</p>
          <div className="section-head">Preset<span className="section-head__count">{Object.keys(WEATHER_PRESETS).length}</span></div>
          {Object.keys(WEATHER_PRESETS).map((preset) => <button
            key={preset}
            type="button"
            className={`row${weather === preset ? ' is-selected' : ''}`}
            onClick={() => onWeather(preset)}
          >
            <span className="row__label">{preset}</span>
            {weather === preset && <span className="row__meta">Applied</span>}
          </button>)}
        </>
        : <>
          <p className="panel__lede">Spawns background traffic around the session vehicle. Denser presets take a few seconds to populate.</p>
          <div className="section-head">Density<span className="section-head__count">{TRAFFIC_PRESETS.length}</span></div>
          {TRAFFIC_PRESETS.map((preset) => <button
            key={preset}
            type="button"
            className={`row${traffic === preset ? ' is-selected' : ''}`}
            onClick={() => onTraffic(preset)}
          >
            <span className="row__label">{preset}</span>
            {traffic === preset && <span className="row__meta">Applied</span>}
          </button>)}
        </>}
      <p className="field__hint">Server state is write-only here: the twin never reads a preset back, so this shows what you last sent.</p>
    </div>
  </aside>;
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="field">
    <span className="field__label">{label}</span>
    <span className="field__value">{value}{hint && <span className="field__hint"> {hint}</span>}</span>
  </div>;
}
