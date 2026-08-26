import { useEffect, useRef, useState } from 'react';
import { TwinScene, type SceneFraming } from '../components/TwinScene';
import type { DriveSocket } from '../state/twin';
import type { TruthFrame } from '../lib/truth';
import './canvas.css';

/** Held keys are sampled, not edge-triggered: the server holds the last control
 * (zero-order hold) and applies it on the next 20 Hz tick, so the client must
 * keep restating the current key state. 50 ms matches that tick. */
const CONTROL_INTERVAL_MS = 50;
/** The keys this view claims. A membership table, not a list: every lookup is
 * `DRIVE_KEYS[key]` on a keydown, never a scan. */
const DRIVE_KEYS: Record<string, true> = {
  w: true, a: true, s: true, d: true,
  arrowup: true, arrowdown: true, arrowleft: true, arrowright: true,
};

/** Which physical keys light up for a logical control. */
const KEY_HINTS: readonly { readonly cap: string; readonly aliases: readonly string[] }[] = [
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
      // A new Set each event: the key caps re-render on press and release
      // without this effect ever depending on the rendered state, which is
      // what keeps the keyup listener attached for the life of the session.
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
  const state = active ? 'active' : fixtureMode ? 'fixture' : 'ready';

  return <div className="cv-view cv-drive" data-drive-state={state}>
    <TwinScene
      className="cv-stage"
      frames={frames}
      followActorId={drive.egoActorId ?? fixtureEgoId}
      cameraMode={cameraMode}
      onFraming={(report) => setFraming(report.state)}
    />

    <div className="cv-overlay">
      <div className="cv-slot cv-slot--tl">
        <section className={active ? 'cv-card cv-card--accent' : 'cv-card'} aria-label="Ego telemetry">
          <div className="cv-card__head">
            <p className={active ? 'cv-eyebrow cv-eyebrow--on' : 'cv-eyebrow'}>Drive · Manual control</p>
            <span
              className={active ? 'cv-pill cv-pill--on' : 'cv-pill'}
              data-testid="drive-status"
            >
              <i className={active ? 'cv-dot cv-dot--on' : 'cv-dot cv-dot--off'} />
              {active ? 'Active' : fixtureMode ? 'Fixture' : 'Ready'}
            </span>
          </div>

          {/* With no session there is no vehicle, and the last telemetry tick is
            * stale: report no reading rather than a number that means nothing.
            * The value arrives from the server already in km/h. */}
          <div className={active ? 'cv-readout' : 'cv-readout is-idle'}>
            <span className="cv-readout__value" data-testid="drive-speed">{active ? Math.round(telemetry.speed) : '––'}</span>
            <span className="cv-readout__unit">km/h</span>
          </div>

          <dl className="cv-facts">
            <div>
              <dt>Gear</dt>
              <dd data-testid="drive-gear">{active ? telemetry.gear : '––'}</dd>
            </div>
            <div>
              <dt>Ego</dt>
              <dd title={drive.egoActorId ?? undefined}>{drive.egoActorId ?? 'unbound'}</dd>
            </div>
          </dl>

          <button
            className={active ? 'cv-action cv-action--danger cv-action--block' : 'cv-action cv-action--primary cv-action--block'}
            data-testid="drive-session"
            onClick={() => {
              if (fixtureMode) setFixtureActive(!fixtureActive);
              else if (drive.active) drive.endSession();
              else drive.startSession();
            }}
          >{active ? 'End session' : 'Start drive session'}</button>
        </section>

        {framing === 'no-coverage' && <aside className="cv-card cv-card--warn" role="status" data-testid="drive-coverage">
          <p className="cv-eyebrow cv-eyebrow--warn">Coverage</p>
          <h2 className="cv-title">Ego outside mapped tile coverage</h2>
          <p className="cv-copy">
            The road network extends past the streamed 3D tiles, so the twin has no geometry to draw
            at this position. Telemetry is still live.
          </p>
          <p className="cv-note">Steer back onto the mapped area and the scene returns on its own.</p>
        </aside>}
      </div>

      <div className="cv-slot cv-slot--tr">
        <div className="cv-card cv-card--tight" aria-label="Drive camera">
          <p className="cv-eyebrow">Camera</p>
          <div className="cv-seg" role="radiogroup" aria-label="Drive camera framing" style={{ marginTop: 8 }}>
            {(['chase', 'first-person'] as const).map((option) => <button
              key={option}
              className="cv-seg__item"
              role="radio"
              aria-checked={cameraMode === option}
              onClick={() => setCameraMode(option)}
            >{option === 'chase' ? 'Chase' : 'First person'}</button>)}
          </div>
        </div>
      </div>

      <div className="cv-slot cv-slot--bl">
        <div className="cv-card cv-card--tight" aria-label="Drive controls">
          <p className="cv-eyebrow">Controls</p>
          <div className="cv-keys" style={{ marginTop: 8 }}>
            {KEY_HINTS.map(({ cap, aliases }) => <kbd
              key={cap}
              className={aliases.some((alias) => held.has(alias)) ? 'cv-key is-held' : 'cv-key'}
            >{cap}</kbd>)}
            <span className="cv-note" style={{ margin: '0 0 0 4px' }}>or arrow keys</span>
          </div>
          <p className="cv-note" style={{ marginTop: 8 }}>
            {active ? 'W throttle · S brake · A/D steer' : 'Start a session to take control'}
          </p>
        </div>
      </div>
    </div>
  </div>;
}
