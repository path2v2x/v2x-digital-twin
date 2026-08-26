import { LiveIcon, ReplayIcon, TargetIcon } from './icons';
import type { CanvasMode } from '../../state/twin';
import type { SceneActor, TruthActor } from '../../lib/truth';

const DAY_SECONDS = 86_400;
/** Every three hours. Denser labels collide below the dock's 920px cap. */
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => ({ hour, second: hour * 3600 }));

interface TimelineDockProps {
  mode: CanvasMode;
  clockMode: 'live' | 'replay';
  clock: number;
  actors: readonly TruthActor[];
  poses: readonly SceneActor[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onLive(): void;
  onSeek(second: number): void;
}

/** Live/replay transport over the day, plus one lane per truth actor.
 *
 * Seeking anywhere on the ruler leaves LIVE and enters REPLAY; the transport
 * is the only place the twin clock is driven from. */
export function TimelineDock({ mode, clockMode, clock, actors, poses, selectedId, onSelect, onLive, onSeek }: TimelineDockProps) {
  const live = clockMode === 'live';
  /* Keyboard capture belongs to the drive canvas: a focusable range input in
   * the dock would swallow WASD, so drive mode gets the ruler without it. */
  const scrubbable = mode !== 'drive';
  /* The server only publishes replay_clock while replaying. In live there is
   * no wall clock to show, and printing the last replayed stamp would read as
   * a live time that is not one. */
  const stamp = live ? '--:--:--' : new Date(clock * 1000).toISOString().slice(11, 19);
  const playheadPercent = (clock / DAY_SECONDS) * 100;

  return <div className="dock__layer">
    <section className="dock" aria-label="Twin timeline" data-testid="twin-dock">
      <div className="dock__glass">
        <div className="dock__head">
          <div className="dock__identity">
            <span className="dock__label">Timeline</span>
            <div className="dock__transport">
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-pressed={live}
                aria-label="Return to live"
                title="Return to live"
                onClick={onLive}
              ><LiveIcon /></button>
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-pressed={!live}
                aria-label="Replay from playhead"
                title="Replay from playhead"
                onClick={() => onSeek(clock)}
              ><ReplayIcon /></button>
            </div>
          </div>

          <div className="dock__ruler">
            {TICKS.map(({ hour }) => <span className="dock__tick" key={hour}>
              <span>{String(hour).padStart(2, '0')}:00</span>
            </span>)}
            <span className="dock__playhead" style={{ left: `${playheadPercent}%` }} aria-hidden />
            {scrubbable && <input
              className="dock__scrub"
              type="range"
              min={0}
              max={DAY_SECONDS}
              step={1}
              value={clock}
              aria-label="Replay clock"
              aria-valuetext={live ? `seek target ${new Date(clock * 1000).toISOString().slice(11, 19)} UTC` : `${stamp} UTC`}
              onChange={(event) => onSeek(Number(event.target.value))}
            />}
            <span className="dock__clock">{stamp} <span className="meta">{live ? 'live · no replay clock' : 'replay · utc'}</span></span>
          </div>
        </div>

        <div className="dock__lanes">
          {actors.length === 0
            ? <div className="empty dock__empty">
              <span className="empty__title">No actors in this frame</span>
              <span className="empty__text">Load a scenario or place a vehicle from the rail; each one takes a lane here.</span>
            </div>
            : actors.map((actor) => <Lane
              key={actor.id}
              actor={actor}
              pose={poses.find((candidate) => candidate.id === actor.id) ?? null}
              selected={selectedId === actor.id}
              onSelect={onSelect}
            />)}
        </div>
      </div>
    </section>
  </div>;
}

function Lane({ actor, pose, selected, onSelect }: { actor: TruthActor; pose: SceneActor | null; selected: boolean; onSelect(id: string | null): void }) {
  const speedKmh = pose ? Math.hypot(pose.velocity[0], pose.velocity[2]) * 3.6 : null;
  return <div className={`dock__lane${selected ? ' is-selected' : ''}`}>
    <div className="dock__lane-id">
      <button type="button" className="truncate dock__lane-name" onClick={() => onSelect(selected ? null : actor.id)}>{actor.id}</button>
      <span className="dock__lane-actions">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-pressed={selected}
          aria-label={selected ? `Clear selection for ${actor.id}` : `Inspect ${actor.id}`}
          title={selected ? 'Clear selection' : 'Inspect'}
          onClick={() => onSelect(selected ? null : actor.id)}
        ><TargetIcon /></button>
      </span>
    </div>
    <button type="button" className={`dock__lane-track${selected ? ' is-live' : ''}`} onClick={() => onSelect(selected ? null : actor.id)}>
      {pose
        ? `${actor.class} · ${speedKmh!.toFixed(1)} km/h · ${(pose.yawRad * 180 / Math.PI).toFixed(0)}°`
        : `${actor.class} · awaiting pose`}
    </button>
  </div>;
}
