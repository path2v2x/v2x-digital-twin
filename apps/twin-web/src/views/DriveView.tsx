import { useEffect, useRef, useState } from 'react';
import { TwinScene, type SceneFraming } from '../components/TwinScene';
import type { DriveSocket } from '../state/twin';
import type { TruthFrame } from '../lib/truth';

/** Held keys are sampled, not edge-triggered: the server holds the last control
 * (zero-order hold) and applies it on the next 20 Hz tick, so the client must
 * keep restating the current key state. 50 ms matches that tick. */
const CONTROL_INTERVAL_MS = 50;
const DRIVE_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];

interface DriveViewProps {
  frames: readonly TruthFrame[];
  drive: DriveSocket;
  fixtureMode: boolean;
}

export function DriveView({ frames, drive, fixtureMode }: DriveViewProps) {
  const [fixtureActive, setFixtureActive] = useState(false);
  const [cameraMode, setCameraMode] = useState<'chase' | 'first-person'>('chase');
  const [framing, setFraming] = useState<SceneFraming['state']>('loading');
  const keys = useRef(new Set<string>());
  const active = fixtureMode ? fixtureActive : drive.active;
  const telemetry = fixtureMode ? { speed: 43, gear: 2 } : drive.telemetry;
  // Depend on `transmit` alone. Depending on the whole socket object rebuilds
  // this effect on every telemetry tick, which drops the keyup listener that
  // holds the pressed-key set — the vehicle then keeps its last throttle.
  const { transmit } = drive;

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (!DRIVE_KEYS.includes(event.key.toLowerCase())) return;
      keys.current.add(event.key.toLowerCase());
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase());
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    const loop = window.setInterval(() => {
      if (!active || fixtureMode) return;
      const held = keys.current;
      transmit({
        type: 'control',
        s: (held.has('a') || held.has('arrowleft') ? -1 : 0) + (held.has('d') || held.has('arrowright') ? 1 : 0),
        t: held.has('w') || held.has('arrowup') ? 1 : 0,
        b: held.has('s') || held.has('arrowdown') ? 1 : 0,
        r: false,
      });
    }, CONTROL_INTERVAL_MS);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.clearInterval(loop);
      keys.current.clear();
    };
  }, [active, fixtureMode, transmit]);

  const latest = frames.at(-1);
  const fixtureEgoId = latest?.actors.find((actor) => actor.id.includes('ego'))?.id ?? latest?.actors[0]?.id ?? null;

  return <div className="canvas-fill">
    <TwinScene
      className="canvas__stage"
      frames={frames}
      followActorId={drive.egoActorId ?? fixtureEgoId}
      cameraMode={cameraMode}
      onFraming={(report) => setFraming(report.state)}
    />

    <div className="hud-layer">
      <div className="hud-slot hud-slot--tl">
        <div className="hud hud--stack" aria-label="Ego telemetry">
          <span className="hud__label">
            <i className={active ? 'status-dot status-dot--live' : 'status-dot status-dot--stale'} />
            Driving mode
            <span className="num">{active ? 'Active' : fixtureMode ? 'Fixture' : 'Ready'}</span>
          </span>
          {/* With no session there is no vehicle, and the last telemetry tick is
            * stale: report no reading rather than a number that means nothing. */}
          <span className="hud__row">
            <span className="hud-readout"><strong>{active ? Math.round(telemetry.speed) : '--'}</strong><span className="hud-readout__unit">km/h</span></span>
            <span className="hud-readout__unit">Gear</span>
            <span className="num">{active ? telemetry.gear : '--'}</span>
          </span>
          <span className="hud__row">
            <button
              className={active ? 'btn btn--danger' : 'btn btn--primary'}
              onClick={() => {
                if (fixtureMode) setFixtureActive(!fixtureActive);
                else if (drive.active) drive.endSession();
                else drive.startSession();
              }}
            >{active ? 'End session' : 'Start drive session'}</button>
            <span className="hud__label">{drive.egoActorId ? `Ego ${drive.egoActorId}` : 'No ego bound'}</span>
          </span>
        </div>
        {framing === 'no-coverage' && <p className="notice notice--degraded">
          Ego outside mapped tile coverage
          <span className="field__hint">The road network extends past the streamed 3D tiles, so the twin has no geometry to draw here</span>
        </p>}
      </div>

      <div className="hud-slot hud-slot--tr">
        <div className="hud" aria-label="Drive camera">
          <span className="hud__label">Camera</span>
          <div className="seg" role="radiogroup" aria-label="Drive camera framing">
            {(['chase', 'first-person'] as const).map((option) => <button
              key={option}
              className="seg__item"
              role="radio"
              aria-checked={cameraMode === option}
              onClick={() => setCameraMode(option)}
            >{option === 'chase' ? 'Chase' : 'First person'}</button>)}
          </div>
        </div>
      </div>

      <div className="hud-slot hud-slot--bl">
        <div className="hud" aria-label="Drive controls">
          <span className="hud__row">
            <kbd className="kbd">W</kbd><kbd className="kbd">A</kbd><kbd className="kbd">S</kbd><kbd className="kbd">D</kbd>
            <span className="hud__label">or arrows</span>
          </span>
          <span className="hud__label">{active ? 'Throttle W · brake S · steer A/D' : 'Start a session to take control'}</span>
        </div>
      </div>
    </div>
  </div>;
}
