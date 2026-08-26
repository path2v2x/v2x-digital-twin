import { useEffect, useState, type CSSProperties } from 'react';
import { TwinScene, type SceneFraming } from '../components/TwinScene';
import { calibratedPose, type TwinCamera } from '../lib/cameras';
import type { TruthFrame } from '../lib/truth';

interface CameraCompareViewProps {
  frames: readonly TruthFrame[];
  cameras: readonly TwinCamera[];
}

type ChannelId = TwinCamera['id'];
/** MJPEG feeds are long-lived responses; a failed one is reattached with a new
 * query so the browser cannot serve the dead response from cache. */
type FeedState = { generation: number; failed: boolean };

const FRAMING_NOTICE: Record<SceneFraming['state'], string | null> = {
  loading: null,
  framed: null,
  'no-coverage': 'No mapped ground on this bearing',
  obstructed: 'Scene geometry inside the near field',
  error: 'Map tiles failed to load',
};

export function CameraCompareView({ frames, cameras }: CameraCompareViewProps) {
  const [focused, setFocused] = useState<ChannelId | null>(null);
  const [framing, setFraming] = useState<Partial<Record<ChannelId, SceneFraming>>>({});
  const [feeds, setFeeds] = useState<Partial<Record<ChannelId, FeedState>>>({});

  useEffect(() => {
    if (!focused) return;
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setFocused(null);
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [focused]);

  if (!cameras.length) {
    return <div className="canvas-fill">
      <div className="empty">
        <p className="empty__title">No calibrated channels</p>
        <p className="empty__text">The twin socket has not reported a camera rig yet. Comparison resumes as soon as twin_cameras arrives.</p>
      </div>
    </div>;
  }

  return <div className="canvas-fill">
    <div className={focused ? 'grid-2x2 is-focused' : 'grid-2x2'} aria-label="Real site cameras beside projection-matched twin renders">
      {cameras.map((camera) => {
        const live = camera.feedMode === 'live';
        const feed = feeds[camera.id] ?? { generation: 0, failed: false };
        const view = framing[camera.id];
        const notice = view ? FRAMING_NOTICE[view.state] : null;
        const pose = calibratedPose(camera);
        const aspect = camera.intrinsics.width / camera.intrinsics.height;

        return <article
          key={camera.id}
          data-testid={`camera-${camera.id}`}
          data-framing={view?.state ?? 'loading'}
          data-feed={feed.failed ? 'failed' : camera.feedMode ?? 'unknown'}
          className={`cell${focused && focused !== camera.id ? ' is-hidden' : ''}`}
        >
          <header className="cell__head">
            <span className="cell__id">{camera.id.toUpperCase()}</span>
            <span className="meta">{camera.intrinsics.width} &times; {camera.intrinsics.height}</span>
            <span className="meta">Yaw {pose.yawDeg.toFixed(1)}&deg; &middot; pitch {pose.pitchDeg.toFixed(1)}&deg;</span>
            <span className="cell__status">
              <i className={live && !feed.failed ? 'status-dot status-dot--live' : 'status-dot status-dot--stale'} />
              {feed.failed ? 'Feed lost' : live ? 'Site feed live' : 'Recorded loop'}
              <button
                className="btn btn--sm"
                aria-pressed={focused === camera.id}
                onClick={() => setFocused(focused === camera.id ? null : camera.id)}
              >{focused === camera.id ? 'All channels' : 'Expand'}</button>
            </span>
          </header>

          <div className="cell__body">
            <figure className="pane">
              {/* The fit box carries the real camera's intrinsic aspect, so the
                * twin pane beside it frames exactly the same solid angle. */}
              <div className="pane__frame" style={{ '--pane-ar': aspect } as CSSProperties}>
                <div className="pane__fit">
                  {!feed.failed && <img
                    src={feed.generation ? `${camera.streamUrl}?retry=${feed.generation}` : camera.streamUrl}
                    alt={`${camera.id} site camera feed`}
                    onError={() => setFeeds((current) => ({ ...current, [camera.id]: { generation: feed.generation, failed: true } }))}
                  />}
                  <span className={live && !feed.failed ? 'feed-badge feed-badge--live' : 'feed-badge feed-badge--recorded'}>
                    <i className={live && !feed.failed ? 'status-dot status-dot--live' : 'status-dot status-dot--stale'} />
                    {feed.failed ? 'Feed unavailable' : live ? 'Real · Live' : 'Recorded · Loop'}
                  </span>
                  {feed.failed && <aside className="pane__note">
                    <p className="notice notice--degraded">
                      MJPEG channel dropped
                      <button
                        className="btn btn--sm"
                        onClick={() => setFeeds((current) => ({ ...current, [camera.id]: { generation: feed.generation + 1, failed: false } }))}
                      >Reconnect</button>
                    </p>
                  </aside>}
                </div>
              </div>
              <figcaption className="pane__label">Site camera &middot; {camera.height_m} m pole</figcaption>
            </figure>

            <div className="pane-divider"><span className="pane-divider__tag">Real &middot; Twin</span></div>

            <figure className="pane">
              <div className="pane__frame" style={{ '--pane-ar': aspect } as CSSProperties}>
                <div className="pane__fit">
                  <TwinScene
                    frames={frames}
                    camera={camera}
                    onFraming={(report) => setFraming((current) => ({ ...current, [camera.id]: report }))}
                  />
                  <span className="feed-badge feed-badge--twin">SimForge &middot; Truth</span>
                  {notice && <aside className="pane__note"><p className="notice notice--degraded">{notice}</p></aside>}
                </div>
              </div>
              <figcaption className="pane__label">Projection-matched twin &middot; {pose.verticalFovDeg.toFixed(1)}&deg; vertical FOV</figcaption>
            </figure>
          </div>
        </article>;
      })}
    </div>
  </div>;
}
