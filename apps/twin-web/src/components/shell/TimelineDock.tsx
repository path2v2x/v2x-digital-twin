import { LiveIcon, ReplayIcon } from './icons';
import type { CanvasMode } from '../../state/twin';

const DAY_SECONDS = 86_400;
const RULER = ['00:00', '06:00', '12:00', '18:00', '24:00'];

interface TimelineDockProps {
  mode: CanvasMode;
  clockMode: 'live' | 'replay';
  clock: number;
  onLive(): void;
  onSeek(second: number): void;
}

/** Live/replay transport. Seeking leaves LIVE and enters REPLAY; the transport
 * itself is the only place the twin clock is driven from. */
export function TimelineDock({ mode, clockMode, clock, onLive, onSeek }: TimelineDockProps) {
  const live = clockMode === 'live';
  // Keyboard capture belongs to the drive canvas, so the dock collapses to the
  // clock and transport there instead of offering a full ruler.
  const compact = mode === 'drive';
  const stamp = new Date(clock * 1000).toISOString().slice(11, 19);

  return <section className={`dock${compact ? ' dock--compact' : ''}`} aria-label="Twin timeline">
    <div className="dock__bar">
      <span className="dock__label">Timeline</span>
      <div className="dock__transport">
        <button type="button" className="icon-btn icon-btn--sm" aria-pressed={live} aria-label="Return to live" title="Return to live" onClick={onLive}><LiveIcon /></button>
        <button type="button" className="icon-btn icon-btn--sm" aria-pressed={!live} aria-label="Replay from playhead" title="Replay from playhead" onClick={() => onSeek(clock)}><ReplayIcon /></button>
      </div>
      <span className="dock__clock">{stamp}<small>{live ? 'live · utc' : 'replay · utc'}</small></span>
      {!compact && <div className="dock__track">
        <div className="dock__ruler" aria-hidden>{RULER.map((tick) => <span key={tick}>{tick}</span>)}</div>
        <input
          className="range dock__scrub"
          type="range"
          min={0}
          max={DAY_SECONDS}
          step={1}
          value={clock}
          aria-label="Replay clock"
          aria-valuetext={`${stamp} UTC`}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </div>}
    </div>
  </section>;
}
