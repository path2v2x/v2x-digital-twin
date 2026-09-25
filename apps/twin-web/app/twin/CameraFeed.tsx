"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import type { PoleCamera } from "@simforge-oss/maps/camera-rig";

import type { CameraFeedState, CameraFeeds } from "@/app/lib/live-world/camera-feeds";
import type { WorldClock, WorldReplayCapabilities } from "@/app/lib/live-world/types";
import { cn } from "@/app/lib/utils";
import {
  archiveClipAt,
  archiveListUrl,
  archiveVideoUrl,
  CLIP_LAG_TOLERANCE_SECONDS,
  clipStartupLagSeconds,
  MAX_CLIP_LEAD_MS,
  MIN_CLIP_MS,
  parseArchiveSegments,
  resolveArchiveClip,
  shouldCorrectVideoDrift,
  type ArchiveClipWindow,
  type ArchiveSegment,
} from "./replay-helpers";

export type FeedDisplayState = CameraFeedState | "paused" | "no-recording";

export interface CameraFeedProps {
  camera: PoleCamera;
  feeds: CameraFeeds | null;
  feedState: CameraFeedState;
  clock: WorldClock | null;
  replay: WorldReplayCapabilities | null;
  className?: string;
  onDisplayState?: (state: FeedDisplayState) => void;
}

/** Live multiplexed frames, or the archived recording at the replay clock. */
export function CameraFeed({ camera, feeds, feedState, clock, replay, className, onDisplayState }: CameraFeedProps) {
  const archiveUrlTemplate = replay?.archiveUrlTemplate ?? null;
  return (
    <div className={cn("relative overflow-hidden bg-black", className)} style={{ aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}>
      {clock?.mode === "replay" && replay && archiveUrlTemplate !== null ? (
        <ArchiveFeed camera={camera} clock={clock} replay={replay} archiveUrlTemplate={archiveUrlTemplate} onDisplayState={onDisplayState} />
      ) : feeds ? (
        <LiveFeed camera={camera} feeds={feeds} feedState={feedState} onDisplayState={onDisplayState} />
      ) : (
        <FeedMessage title="No feed" />
      )}
    </div>
  );
}

function LiveFeed({ camera, feeds, feedState, onDisplayState }: { camera: PoleCamera; feeds: CameraFeeds; feedState: CameraFeedState; onDisplayState?: (state: FeedDisplayState) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return feeds.subscribeFrames(camera.id, (frame) => {
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      canvas.getContext("2d")?.drawImage(frame, 0, 0, frame.width, frame.height);
    });
  }, [camera.id, feeds]);

  useEffect(() => {
    onDisplayState?.(feedState);
    if (feedState === "live" || feedState === "replay") return;
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }, [feedState, onDisplayState]);

  return (
    <>
      <canvas ref={canvasRef} className="block h-full w-full object-cover" aria-label={`${camera.label ?? camera.id} live feed`} />
      {feedState === "unavailable" ? <FeedMessage title="Feed unavailable" /> : null}
      {feedState === "starting" ? <FeedMessage title="Connecting…" /> : null}
    </>
  );
}

/** Segment listings cover this window (plus margins) around the replay clock. */
const SEGMENT_WINDOW_MS = 30 * 60_000;
const SEGMENT_MARGIN_MS = 10 * 60_000;
/** A segment ending this close to now is still being recorded. */
const RECORDING_TAIL_MS = 30_000;
/** Least time between re-listings when the clock runs past the last known segment. */
const TAIL_REFRESH_MS = 5_000;
/** After a video error the tile waits this long (replay time) before requesting again. */
const ERROR_RETRY_MS = 10_000;

/**
 * Recorded segments around the replay clock: `undefined` while the first
 * listing loads, `null` when no listing is available (clips are then
 * requested unconstrained).
 */
function useArchiveSegments(template: string | null, channel: string, clockMs: number, offsetSeconds: number): readonly ArchiveSegment[] | null | undefined {
  const [loaded, setLoaded] = useState<{ key: string; segments: ArchiveSegment[] | null; fetchedAt: number } | null>(null);
  const windowStartMs = Number.isFinite(clockMs) ? Math.floor(clockMs / SEGMENT_WINDOW_MS) * SEGMENT_WINDOW_MS - SEGMENT_MARGIN_MS : Number.NaN;
  const key = template !== null && Number.isFinite(windowStartMs) ? `${channel}@${windowStartMs}` : null;
  const current = loaded !== null && loaded.key === key ? loaded : null;
  const lastEndMs = current?.segments?.length ? current.segments.at(-1)!.endMs : Number.NEGATIVE_INFINITY;
  const tailStale = current !== null && clockMs >= lastEndMs - MIN_CLIP_MS && Date.now() - current.fetchedAt > TAIL_REFRESH_MS;
  const needsFetch = key !== null && (current === null || tailStale);

  useEffect(() => {
    if (!needsFetch || template === null || key === null) return;
    const controller = new AbortController();
    let settled = false;
    const url = archiveListUrl(template, channel, windowStartMs, windowStartMs + SEGMENT_WINDOW_MS + 2 * SEGMENT_MARGIN_MS, offsetSeconds);
    const settle = (segments: ArchiveSegment[] | null) => {
      settled = true;
      setLoaded({ key, segments, fetchedAt: Date.now() });
    };
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        // MediaMTX answers 404 when nothing was recorded in the window.
        if (response.status === 404) return settle([]);
        settle(response.ok ? parseArchiveSegments(await response.json(), offsetSeconds) : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) settle(null);
      });
    return () => {
      if (!settled) controller.abort();
    };
  }, [needsFetch, key, template, channel, windowStartMs, offsetSeconds]);

  // The newest segment is still growing while the recorder runs; treat it as open-ended.
  const display = useMemo(() => {
    const segments = current?.segments;
    if (!current || !segments?.length) return segments;
    const last = segments.at(-1)!;
    return last.endMs > current.fetchedAt - RECORDING_TAIL_MS
      ? [...segments.slice(0, -1), { startMs: last.startMs, endMs: Number.POSITIVE_INFINITY }]
      : segments;
  }, [current]);
  if (current === null) return key === null ? null : undefined;
  return display ?? null;
}

function ArchiveFeed({ camera, clock, replay, archiveUrlTemplate, onDisplayState }: { camera: PoleCamera; clock: WorldClock; replay: WorldReplayCapabilities; archiveUrlTemplate: string; onDisplayState?: (state: FeedDisplayState) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const clockMs = clock.timeIso === null ? Number.NaN : Date.parse(clock.timeIso);
  const segments = useArchiveSegments(replay.archiveListUrlTemplate, camera.id, clockMs, replay.archiveOffsetSeconds);
  const [clip, setClip] = useState<ArchiveClipWindow | null>(null);
  const previousClockMs = useRef(Number.NaN);
  const retryAtMs = useRef(Number.NEGATIVE_INFINITY);
  // MediaMTX playback is not seekable, so later requests are led by the measured start-up latency.
  const leadMs = useRef(0);
  const leadCorrections = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(clockMs)) {
      previousClockMs.current = Number.NaN;
      setClip(null);
      return;
    }
    if (segments !== undefined && clockMs >= retryAtMs.current) {
      setClip((current) => {
        const next = resolveArchiveClip(current, previousClockMs.current, clockMs, clock.speed, leadMs.current, segments);
        if (next !== current) leadCorrections.current = 0;
        return next;
      });
    }
    previousClockMs.current = clockMs;
  }, [clockMs, clock.speed, segments]);

  const src = clip ? archiveVideoUrl(archiveUrlTemplate, camera.id, clip, replay.archiveOffsetSeconds) : null;
  const displayState: FeedDisplayState = !src ? (segments === undefined ? "starting" : "no-recording") : clock.speed === 0 ? "paused" : "replay";

  useEffect(() => onDisplayState?.(displayState), [displayState, onDisplayState]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip || !Number.isFinite(clockMs) || video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const targetTime = (clockMs - clip.startMs) / 1_000;
    if (shouldCorrectVideoDrift(video.currentTime, targetTime)) {
      if (isVideoTimeSeekable(video, targetTime)) {
        video.currentTime = targetTime;
      } else if (clock.speed > 0 && !video.paused && leadCorrections.current < 2) {
        const lagSeconds = clipStartupLagSeconds(clip, clockMs, video.currentTime);
        if (lagSeconds > CLIP_LAG_TOLERANCE_SECONDS) {
          const led = archiveClipAt(clockMs, Math.min(MAX_CLIP_LEAD_MS, leadMs.current + lagSeconds * 1_000), segments ?? null);
          if (led) {
            leadCorrections.current += 1;
            leadMs.current = Math.min(MAX_CLIP_LEAD_MS, leadMs.current + lagSeconds * 1_000);
            setClip(led);
            return;
          }
        }
      }
    }
    if (clock.speed === 0) {
      video.pause();
      return;
    }
    video.playbackRate = clock.speed;
    // Muted autoplay can be gated while metadata loads; the next clock sample retries.
    void video.play().catch(() => undefined);
  }, [clip, clock.speed, clockMs, segments]);

  return (
    <>
      {src ? (
        <video
          ref={videoRef}
          key={src}
          src={src}
          className="block h-full w-full object-cover"
          muted
          playsInline
          preload="auto"
          data-archive-camera={camera.id}
          onLoadedMetadata={(event) => {
            if (!clip || !Number.isFinite(clockMs)) return;
            const targetTime = (clockMs - clip.startMs) / 1_000;
            if (isVideoTimeSeekable(event.currentTarget, targetTime)) event.currentTarget.currentTime = targetTime;
            if (clock.speed > 0) {
              event.currentTarget.playbackRate = clock.speed;
              void event.currentTarget.play().catch(() => undefined);
            }
          }}
          onError={() => {
            retryAtMs.current = clockMs + ERROR_RETRY_MS;
            setClip(null);
          }}
          // The clip ends with its segment (or earlier if the recording is shorter); re-anchor at the clock.
          onEnded={() => setClip(null)}
        />
      ) : null}
      {displayState === "no-recording" ? <FeedMessage title="No recording" /> : null}
    </>
  );
}

function isVideoTimeSeekable(video: HTMLVideoElement, targetTime: number): boolean {
  for (let index = 0; index < video.seekable.length; index += 1) {
    if (video.seekable.start(index) <= targetTime && targetTime <= video.seekable.end(index)) return true;
  }
  return false;
}

function FeedMessage({ title }: { title: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70 text-center">
      <VideoOff className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
    </div>
  );
}
