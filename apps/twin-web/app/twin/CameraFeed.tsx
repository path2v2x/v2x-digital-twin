"use client";

import { useEffect, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import type { PoleCamera } from "@simforge-oss/maps/camera-rig";

import type { CameraFeedState, CameraFeeds } from "@/app/lib/live-world/camera-feeds";
import type { WorldClock } from "@/app/lib/live-world/types";
import { cn } from "@/app/lib/utils";
import {
  archiveClipAt,
  archiveVideoUrl,
  CLIP_LAG_TOLERANCE_SECONDS,
  clipStartupLagSeconds,
  MAX_CLIP_LEAD_MS,
  resolveArchiveClip,
  shouldCorrectVideoDrift,
  type ArchiveClipWindow,
} from "./replay-helpers";

export type FeedDisplayState = CameraFeedState | "paused" | "no-recording";

export interface CameraFeedProps {
  camera: PoleCamera;
  feeds: CameraFeeds | null;
  feedState: CameraFeedState;
  clock: WorldClock | null;
  archiveUrlTemplate: string | null;
  archiveOffsetSeconds: number;
  className?: string;
  onDisplayState?: (state: FeedDisplayState) => void;
}

/** Live multiplexed frames, or the archived recording at the replay clock. */
export function CameraFeed({ camera, feeds, feedState, clock, archiveUrlTemplate, archiveOffsetSeconds, className, onDisplayState }: CameraFeedProps) {
  const replaying = clock?.mode === "replay" && archiveUrlTemplate !== null;
  return (
    <div className={cn("relative overflow-hidden bg-black", className)} style={{ aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}>
      {replaying ? (
        <ArchiveFeed camera={camera} clock={clock} archiveUrlTemplate={archiveUrlTemplate} archiveOffsetSeconds={archiveOffsetSeconds} onDisplayState={onDisplayState} />
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

function ArchiveFeed({ camera, clock, archiveUrlTemplate, archiveOffsetSeconds, onDisplayState }: { camera: PoleCamera; clock: WorldClock; archiveUrlTemplate: string; archiveOffsetSeconds: number; onDisplayState?: (state: FeedDisplayState) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  const clockMs = clock.timeIso === null ? Number.NaN : Date.parse(clock.timeIso);
  const [clip, setClip] = useState<ArchiveClipWindow | null>(null);
  const previousClockMs = useRef(Number.NaN);
  // MediaMTX playback is not seekable, so later requests are led by the measured start-up latency.
  const leadMs = useRef(0);
  const leadCorrections = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(clockMs)) {
      previousClockMs.current = Number.NaN;
      setClip(null);
      return;
    }
    setClip((current) => {
      const next = resolveArchiveClip(current, previousClockMs.current, clockMs, clock.speed, leadMs.current);
      if (next !== current) leadCorrections.current = 0;
      return next;
    });
    previousClockMs.current = clockMs;
  }, [clockMs, clock.speed]);

  const src = clip ? archiveVideoUrl(archiveUrlTemplate, camera.id, clip, archiveOffsetSeconds) : null;
  const displayState: FeedDisplayState = unavailable || !src ? "no-recording" : clock.speed === 0 ? "paused" : "replay";

  useEffect(() => setUnavailable(false), [src]);
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
          leadCorrections.current += 1;
          leadMs.current = Math.min(MAX_CLIP_LEAD_MS, leadMs.current + lagSeconds * 1_000);
          setClip(archiveClipAt(clockMs, leadMs.current));
          return;
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
  }, [clip, clock.speed, clockMs]);

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
          onError={() => setUnavailable(true)}
          // A recording gap shortens the served clip; re-anchor at the clock.
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
