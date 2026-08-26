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

/** Corner-bracket glyph: outward brackets expand a channel, inward arrows
 * collapse the focused one back to the four-up. */
const EXPAND_PATHS: Record<'expand' | 'collapse', readonly string[]> = {
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
    return <div className="cv-view cv-cams">
      <div className="cv-empty">
        <p className="cv-eyebrow">Channels</p>
        <h2 className="cv-title">No calibrated channels</h2>
        <p className="cv-copy">
          The twin socket has not reported a camera rig yet. Comparison resumes as soon as
          twin_cameras arrives.
        </p>
      </div>
    </div>;
  }

  return <div className="cv-view cv-cams">
    <div
      className="cv-cams__grid"
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
            <span className="cv-prov" style={{ border: 0, padding: 0 }}>
              <span>{camera.intrinsics.width}&times;{camera.intrinsics.height}</span>
              <span>yaw <b>{pose.yawDeg.toFixed(1)}&deg;</b></span>
              <span>pitch <b>{pose.pitchDeg.toFixed(1)}&deg;</b></span>
            </span>
            <span className={feed.failed ? 'cv-pill cv-pill--down' : live ? 'cv-pill cv-pill--on' : 'cv-pill'}>
              <i className={feed.failed ? 'cv-dot cv-dot--down' : live ? 'cv-dot cv-dot--on' : 'cv-dot cv-dot--off'} />
              {feed.failed ? 'Signal lost' : live ? 'Site feed live' : 'Recorded loop'}
            </span>
            <button
              className="cv-iconbtn"
              aria-label={isFocused ? `Show all channels` : `Expand ${camera.id.toUpperCase()}`}
              aria-pressed={isFocused}
              onClick={() => setFocused(isFocused ? null : camera.id)}
            ><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              {EXPAND_PATHS[isFocused ? 'collapse' : 'expand'].map((d) => <path key={d} d={d} />)}
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
              <span className={feed.failed ? 'cv-badge cv-badge--down' : live ? 'cv-badge cv-badge--live' : 'cv-badge cv-badge--recorded'}>
                <i className={feed.failed ? 'cv-dot cv-dot--down' : live ? 'cv-dot cv-dot--on' : 'cv-dot cv-dot--off'} />
                {feed.failed ? 'Feed unavailable' : live ? 'Real · Live' : 'Recorded · Loop'}
              </span>
              {feed.failed && <div className="cv-fail" role="status">
                <p className="cv-eyebrow cv-eyebrow--warn">MJPEG channel dropped</p>
                <h3 className="cv-title" style={{ margin: 0, fontSize: 14 }}>Feed unavailable</h3>
                <button
                  className="cv-action cv-action--sm"
                  onClick={() => setFeeds((current) => ({ ...current, [camera.id]: { generation: feed.generation + 1, failed: false } }))}
                >Reconnect</button>
              </div>}
            </div>

            <div className="cv-seam"><span>Real &rarr; Twin</span></div>

            <div className="cv-pane">
              <TwinScene
                className="cv-pane__media"
                frames={frames}
                camera={camera}
                onFraming={(report) => setFraming((current) => ({ ...current, [camera.id]: report }))}
              />
              <span className="cv-badge cv-badge--twin">Twin · Truth</span>
              {notice && <div className="cv-pane__note">
                <p className="cv-hint cv-hint--warn">
                  <i className="cv-dot cv-dot--warn" />
                  {notice}
                </p>
              </div>}
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
