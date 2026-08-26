import { CameraIcon, DriveIcon, SceneIcon } from './icons';
import type { CanvasMode } from '../../state/twin';

const MODES: readonly { id: CanvasMode; label: string; Icon: () => React.JSX.Element }[] = [
  { id: 'scene', label: 'Scene', Icon: SceneIcon },
  { id: 'drive', label: 'Drive', Icon: DriveIcon },
  { id: 'cameras', label: 'Cameras', Icon: CameraIcon },
];

interface TopBarProps {
  mode: CanvasMode;
  onMode(mode: CanvasMode): void;
  connected: boolean;
  fixtureMode: boolean;
  clockMode: 'live' | 'replay';
  alertCount: number;
  onAlerts(): void;
}

export function TopBar({ mode, onMode, connected, fixtureMode, clockMode, alertCount, onAlerts }: TopBarProps) {
  return <header className="topbar">
    <div className="topbar__brand">
      <span className="brand-mark" aria-hidden>SF</span>
      <span className="brand-id"><strong>SimForge</strong><span>Richmond V2X twin</span></span>
    </div>
    <div className="topbar__slot">
      <div className="seg" role="radiogroup" aria-label="Canvas mode">
        {MODES.map(({ id, label, Icon }) => <button
          key={id}
          type="button"
          role="radio"
          className="seg__item"
          aria-checked={mode === id}
          onClick={() => onMode(id)}
        ><Icon />{label}</button>)}
      </div>
    </div>
    <div className="topbar__trailing">
      {alertCount > 0 && <button type="button" className="badge badge--warn" onClick={onAlerts}>EVA {alertCount}</button>}
      <span className={`badge${clockMode === 'live' ? ' badge--live' : ''}`}>
        <i className={`status-dot${clockMode === 'live' ? ' status-dot--live' : ' status-dot--stale'}`} />
        {clockMode === 'live' ? 'Live' : 'Replay'}
      </span>
      <span className={`badge${connected ? ' badge--ok' : ' badge--danger'}`}>
        {fixtureMode ? 'Fixture replay' : connected ? 'Connected' : 'Offline'}
      </span>
    </div>
  </header>;
}
