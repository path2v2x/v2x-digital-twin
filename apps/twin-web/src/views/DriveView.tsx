import { useEffect, useRef, useState } from 'react';
import { TwinScene, type SceneFraming } from '../components/TwinScene';
import type { DriveSocket } from '../state/twin';
import type { TruthFrame } from '../lib/truth';
import './canvas.css';

/** Held keys are sampled, not edge-triggered: the server holds the last control
 * (zero-order hold) and applies it on the next 20 Hz tick, so the client must
 * keep restating the current key state. 50 ms matches that tick. */
const CONTROL_INTERVAL_MS = 50;
/** The keys this view claims. A membership table, not a list: the lookup runs
 * on every keydown the window sees, including ones meant for other surfaces. */
const DRIVE_KEYS: Record<string, true> = {
  w: true, a: true, s: true, d: true,
  arrowup: true, arrowdown: true, arrowleft: true, arrowright: true,
};

/** Which physical keys light a cap up, so the hint reflects what the server is
 * actually being sent rather than a static legend. */
const KEY_CAPS: readonly { readonly cap: string; readonly aliases: readonly string[] }[] = [
  { cap: 'W', aliases: ['w', 'arrowup'] },
  { cap: 'A', aliases: ['a', 'arrowleft'] },
  { cap: 'S', aliases: ['s', 'arrowdown'] },
  { cap: 'D', aliases: ['d', 'arrowright'] },
];

interface DriveViewProps {
  frames: readonly TruthFrame[];
  drive: DriveSocket;
  fixtureMode: boolean;
}

export function DriveView({ frames, drive, fixtureMode }: DriveViewProps) {
  const [fixtureActive, setFixtureActive] = useState(false);
  const [cameraMode, setCameraMode] = useState<'chase' | 'first-person'>('chase');
  const [framing, setFraming] = useState<SceneFraming['state']>('loading');
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const keys = useRef(new Set<string>());
  const active = fixtureMode ? fixtureActive : drive.active;
  const telemetry = fixtureMode ? { speed: 43, gear: 2 } : drive.telemetry;
  // Depend on `transmit` alone. Depending on the whole socket object rebuilds
  // this effect on every telemetry tick, which drops the keyup listener that
  // holds the pressed-key set — the vehicle then keeps its last throttle.
  const { transmit } = drive;

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!DRIVE_KEYS[key]) return;
      keys.current.add(key);
      // A fresh Set per event so the caps re-render on press and release. This
      // effect never depends on that state, which is what keeps the keyup
      // listener attached for the whole session.
      setHeld(new Set(keys.current));
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => {
      keys.current.delete(event.key.toLowerCase());
      setHeld(new Set(keys.current));
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    const loop = window.setInterval(() => {
      if (!active || fixtureMode) return;
      const pressed = keys.current;
      transmit({
        type: 'control',
        s: (pressed.has('a') || pressed.has('arrowleft') ? -1 : 0) + (pressed.has('d') || pressed.has('arrowright') ? 1 : 0),
        t: pressed.has('w') || pressed.has('arrowup') ? 1 : 0,
        b: pressed.has('s') || pressed.has('arrowdown') ? 1 : 0,
        r: false,
      });
    }, CONTROL_INTERVAL_MS);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.clearInterval(loop);
      keys.current.clear();
      setHeld(new Set());
    };
  }, [active, fixtureMode, transmit]);

  const latest = frames.at(-1);
  const fixtureEgoId = latest?.actors.find((actor) => actor.id.includes('ego'))?.id ?? latest?.actors[0]?.id ?? null;

  return <div className="canvas-fill" data-drive-active={String(active)}>
    <TwinScene
      className="canvas__stage"
      frames={frames}
      followActorId={drive.egoActorId ?? fixtureEgoId}
      cameraMode={cameraMode}
      onFraming={(report) => setFraming(report.state)}
    />

    <div className="hud-layer">
      <div className="hud-slot hud-slot--tl">
        <section className={active ? 'card card--amber' : 'card'} aria-label="Ego telemetry">
          <div className="hud__row">
            <p className={active ? 'eyebrow' : 'meta'}>Drive · manual control</p>
            <span
              className={active ? 'pill pill--active' : 'pill pill--idle'}
              data-testid="drive-status"
              style={{ marginLeft: 'auto' }}
            >
              <i className={active ? 'dot dot--active' : 'dot dot--idle'} />
              {active ? 'Active' : fixtureMode ? 'Fixture' : 'Ready'}
            </span>
          </div>

          {/* With no session there is no vehicle and the last telemetry tick is
            * stale, so report no reading rather than a number that means
            * nothing. The value arrives from the server already in km/h. */}
          <div className={active ? 'hud-readout hud-readout--xl' : 'hud-readout hud-readout--xl is-idle'}>
            <strong data-testid="drive-speed">{active ? Math.round(telemetry.speed) : '––'}</strong>
            <span className="hud-readout__unit">km/h</span>
          </div>

          <dl className="cv-facts">
            <div>
              <dt className="meta">Gear</dt>
              <dd data-testid="drive-gear">{active ? telemetry.gear : '––'}</dd>
            </div>
            <div>
              <dt className="meta">Ego</dt>
              <dd title={drive.egoActorId ?? undefined}>{drive.egoActorId ?? 'unbound'}</dd>
            </div>
          </dl>

          <div className="card__foot">
            <button
              className={active ? 'btn btn--danger' : 'btn btn--primary'}
              data-testid="drive-session"
              onClick={() => {
                if (fixtureMode) setFixtureActive(!fixtureActive);
                else if (drive.active) drive.endSession();
                else drive.startSession();
              }}
            >{active ? 'End session' : 'Start drive session'}</button>
          </div>
        </section>

        {framing === 'no-coverage' && <aside className="card" role="status" data-testid="drive-coverage">
          <p className="eyebrow">Coverage</p>
          <h2 className="card__title">Ego outside mapped tile coverage</h2>
          <p className="card__body">
            The road network extends past the streamed 3D tiles, so the twin has no geometry to draw
            at this position. Telemetry is still live.
          </p>
          <p className="hint">
            <i className="hint__dot" />
            Steer back onto the mapped area and the scene returns on its own
          </p>
        </aside>}
      </div>

      <div className="hud-slot hud-slot--tr">
        <div className="hud hud--stack" aria-label="Drive camera">
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
        <div className="hud hud--stack" aria-label="Drive controls">
          <span className="hud__label">Controls</span>
          <div className="hud__row">
            {KEY_CAPS.map(({ cap, aliases }) => <kbd
              key={cap}
              className={aliases.some((alias) => held.has(alias)) ? 'kbd is-held' : 'kbd'}
            >{cap}</kbd>)}
            <span className="meta">or arrow keys</span>
          </div>
          <span className="meta">
            {active ? 'W throttle · S brake · A/D steer' : 'Start a session to take control'}
          </span>
        </div>
      </div>
    </div>
  </div>;
}
