import { useEffect, useState, type CSSProperties } from 'react';
import { TwinScene, type SceneFraming } from '../components/TwinScene';
import { calibratedPose, type TwinCamera } from '../lib/cameras';
import type { TruthFrame } from '../lib/truth';
import './canvas.css';

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

/** Corner-bracket glyph: outward brackets expand a channel to the full canvas,
 * inward arrows collapse the focused one back to the four-up. */
const FOCUS_GLYPH: Record<'expand' | 'collapse', readonly string[]> = {
  expand: ['M6 2.5H2.5V6', 'M10 2.5h3.5V6', 'M6 13.5H2.5V10', 'M10 13.5h3.5V10'],
  collapse: ['M9.5 2.5h4v4', 'M13.5 2.5 9 7', 'M6.5 13.5h-4v-4', 'M2.5 13.5 7 9'],
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
      <div className="cv-centre">
        <div className="empty">
          <p className="empty__title">No calibrated channels</p>
          <p className="empty__text">
            The twin socket has not reported a camera rig yet. Comparison resumes as soon as
            twin_cameras arrives.
          </p>
        </div>
      </div>
    </div>;
  }

  return <div className="canvas-fill">
    <div
      className="cv-grid"
      data-focused={focused ? 'true' : 'false'}
      aria-label="Real site cameras beside projection-matched twin renders"
    >
      {cameras.map((camera) => {
        const live = camera.feedMode === 'live';
        const feed = feeds[camera.id] ?? { generation: 0, failed: false };
        const view = framing[camera.id];
        const notice = view ? FRAMING_NOTICE[view.state] : null;
        const pose = calibratedPose(camera);
        // The pane box carries the real camera's intrinsic aspect, so the twin
        // pane beside it frames exactly the same solid angle — and, being
        // width-driven, neither pane letterboxes inside its cell.
        const aspect = camera.intrinsics.width / camera.intrinsics.height;
        const isFocused = focused === camera.id;

        return <figure
          key={camera.id}
          className="cv-chan"
          data-testid={`camera-${camera.id}`}
          data-framing={view?.state ?? 'loading'}
          data-feed={feed.failed ? 'failed' : camera.feedMode ?? 'unknown'}
          hidden={focused !== null && !isFocused}
          style={{ '--pane-ar': aspect } as CSSProperties}
        >
          <div className="cv-chan__head">
            <span className="cv-chan__id">{camera.id.toUpperCase()}</span>
            <span className="cv-prov">
              <span>{camera.intrinsics.width}&times;{camera.intrinsics.height}</span>
              <span>yaw <b>{pose.yawDeg.toFixed(1)}&deg;</b></span>
              <span>pitch <b>{pose.pitchDeg.toFixed(1)}&deg;</b></span>
            </span>
            <span className={feed.failed ? 'pill pill--danger' : live ? 'pill pill--active' : 'pill pill--idle'}>
              <i className={feed.failed ? 'dot dot--danger' : live ? 'dot dot--active' : 'dot dot--idle'} />
              {feed.failed ? 'Signal lost' : live ? 'Site feed live' : 'Recorded loop'}
            </span>
            <button
              className="icon-btn icon-btn--sm"
              aria-label={isFocused ? 'Show all channels' : `Expand ${camera.id.toUpperCase()}`}
              aria-pressed={isFocused}
              onClick={() => setFocused(isFocused ? null : camera.id)}
            ><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              {FOCUS_GLYPH[isFocused ? 'collapse' : 'expand'].map((d) => <path key={d} d={d} />)}
            </svg></button>
          </div>

          <div className="cv-pair">
            <div className="cv-pane">
              {!feed.failed && <img
                src={feed.generation ? `${camera.streamUrl}?retry=${feed.generation}` : camera.streamUrl}
                alt={`${camera.id} site camera feed`}
                onError={() => setFeeds((current) => ({ ...current, [camera.id]: { generation: feed.generation, failed: true } }))}
              />}
              {/* The badge states only what the server reported: live is live,
                * anything else is a recorded loop, and a dropped channel shows
                * no frame at all. */}
              <span className={feed.failed ? 'feed-badge feed-badge--danger' : live ? 'feed-badge feed-badge--live' : 'feed-badge feed-badge--recorded'}>
                <i className={feed.failed ? 'dot dot--danger' : live ? 'dot dot--active' : 'dot dot--idle'} />
                {feed.failed ? 'Feed unavailable' : live ? 'Real · Live' : 'Recorded · Loop'}
              </span>
              {feed.failed && <div className="cv-fail" role="status">
                <p className="meta">MJPEG channel dropped</p>
                <p className="empty__title">Feed unavailable</p>
                <button
                  className="btn btn--sm"
                  onClick={() => setFeeds((current) => ({ ...current, [camera.id]: { generation: feed.generation + 1, failed: false } }))}
                >Reconnect</button>
              </div>}
            </div>

            <div className="cv-seam"><span className="meta">Real &rarr; Twin</span></div>

            <div className="cv-pane">
              <TwinScene
                className="cv-pane__media"
                frames={frames}
                camera={camera}
                onFraming={(report) => setFraming((current) => ({ ...current, [camera.id]: report }))}
              />
              <span className="feed-badge feed-badge--twin">Twin &middot; Truth</span>
              {notice && <aside className="pane__note"><p className="notice notice--degraded">{notice}</p></aside>}
            </div>
          </div>

          <figcaption className="cv-prov">
            <span>site camera <b>{camera.height_m} m pole</b></span>
            <span>projection matched <b>{pose.verticalFovDeg.toFixed(1)}&deg; vfov</b></span>
            <span>heading <b>{camera.heading_deg}&deg;</b></span>
            <span>fx <b>{camera.intrinsics.fx.toFixed(0)}</b></span>
          </figcaption>
        </figure>;
      })}
    </div>
  </div>;
}
