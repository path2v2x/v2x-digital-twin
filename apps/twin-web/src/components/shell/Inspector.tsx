import { CloseIcon } from './icons';
import { TRAFFIC_PRESETS, WEATHER_PRESETS } from '../../state/catalog';
import type { SceneActor, TruthActor } from '../../lib/truth';

interface InspectorProps {
  actor: TruthActor | null;
  sceneActor: SceneActor | null;
  onClose(): void;
  weather: string;
  onWeather(preset: string): void;
  traffic: string;
  onTraffic(preset: string): void;
}

/** One selection-driven panel. With a truth object selected it shows that
 * object; with nothing selected it holds the world controls. */
export function Inspector({ actor, sceneActor, onClose, weather, onWeather, traffic, onTraffic }: InspectorProps) {
  if (actor) {
    const speedKmh = sceneActor ? Math.hypot(sceneActor.velocity[0], sceneActor.velocity[2]) * 3.6 : null;
    return <aside className="inspector" aria-label="Object inspector">
      <div className="inspector__head">
        <strong title={actor.id}>{actor.id}</strong>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Clear selection" onClick={onClose}><CloseIcon /></button>
      </div>
      <div className="inspector__body scroll">
        <Field label="Class" value={actor.class} />
        <Field label="Speed" value={speedKmh === null ? 'no pose' : `${speedKmh.toFixed(1)} km/h`} />
        <Field label="Dimensions" value={`${actor.dims.l} × ${actor.dims.w} × ${actor.dims.h} m`} />
        <Field label="Position" value={sceneActor ? `${sceneActor.position[0].toFixed(1)}, ${sceneActor.position[2].toFixed(1)}` : 'no pose'} hint="scene x, z" />
        <Field label="Heading" value={sceneActor ? `${(sceneActor.yawRad * 180 / Math.PI).toFixed(1)}°` : 'no pose'} />
        <Field label="Source" value={/mirror|ghost/.test(actor.id) ? 'Mirrored V2X detection' : 'SimForge truth'} />
      </div>
    </aside>;
  }

  return <aside className="inspector" aria-label="World inspector">
    <div className="inspector__head"><strong>World</strong></div>
    <div className="inspector__body scroll">
      <div className="field">
        <span className="field__label">Weather</span>
        <select className="select" aria-label="Weather preset" value={weather} onChange={(event) => onWeather(event.target.value)}>
          {Object.keys(WEATHER_PRESETS).map((preset) => <option key={preset} value={preset}>{preset}</option>)}
        </select>
      </div>
      <div className="field">
        <span className="field__label">Ambient traffic</span>
        <select className="select" aria-label="Ambient traffic preset" value={traffic} onChange={(event) => onTraffic(event.target.value)}>
          {TRAFFIC_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
        </select>
      </div>
      <div className="field"><span className="field__hint">Applied to the live world immediately</span></div>
    </div>
  </aside>;
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="field">
    <span className="field__label">{label}</span>
    <span className="field__value">{value}</span>
    {hint && <span className="field__hint">{hint}</span>}
  </div>;
}
