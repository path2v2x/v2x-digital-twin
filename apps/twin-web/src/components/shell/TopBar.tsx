import { AlertIcon, CameraIcon, CheckIcon, DriveIcon, LiveIcon, LogoMark, ReplayIcon, SceneIcon, SettingsIcon } from './icons';
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
  settingsOpen: boolean;
  onSettings(): void;
}

/** The one horizontal plate in the editor. It is translucent rather than
 * opaque, and desaturated rather than merely blurred, so the daylight sky
 * moving behind it never tints the chrome as the camera swings. */
export function TopBar({ mode, onMode, connected, fixtureMode, clockMode, alertCount, onAlerts, settingsOpen, onSettings }: TopBarProps) {
  const live = clockMode === 'live';
  return <header className="topbar" data-testid="twin-topbar">
    <div className="topbar__inner">
      <span className="topbar__logo" aria-hidden><LogoMark /></span>

      <span className="topbar__title" aria-label="SIMFORGE - Twin">
        <span className="brand-word">SimForge</span>
        <span className="brand-sep" aria-hidden>-</span>
        <span className="brand-context">Twin</span>
      </span>

      <div className="topbar__actions">
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
        {alertCount > 0 && <button
          type="button"
          className="action"
          onClick={onAlerts}
          aria-label={`Show ${alertCount} EVA alerts`}
        ><AlertIcon />EVA {alertCount}</button>}

        {/* Two independent truths, so two indicators: whether the socket is up,
          * and which clock the frames are stamped against. */}
        <span className={`pill${live ? ' pill--active' : ''}`}>
          {live ? <LiveIcon /> : <ReplayIcon />}
          {live ? 'Live' : 'Replay'}
        </span>

        <span className={`pill${connected ? ' pill--ok' : ' pill--danger'}`} data-testid="twin-connection">
          {connected ? <CheckIcon /> : <AlertIcon />}
          {fixtureMode ? 'Fixture replay' : connected ? 'Connected' : 'Offline'}
        </span>

        <button
          type="button"
          className="action"
          aria-pressed={settingsOpen}
          aria-label="World settings"
          onClick={onSettings}
        ><SettingsIcon />Settings</button>

        {/* The only link out of the twin: back to the V2X landing page. The
          * drive app and architecture page are siblings reached from there. */}
        <a className="action" href="https://path2v2x.net/" aria-label="V2X home">&larr; Home</a>
      </div>
    </div>
  </header>;
}
