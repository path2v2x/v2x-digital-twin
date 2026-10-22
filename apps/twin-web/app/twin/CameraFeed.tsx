"use client";

import { useEffect, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import type { PoleCamera } from "@simforge-oss/maps/camera-rig";

import { cn } from "@/app/lib/utils";
import { DEFAULT_WINDOW_MS, windowAround, type ArchiveAccess } from "../footage/archive";
import { ArchivePlayer, type FootageStatus } from "../footage/archive-player";
import { FootageLoading } from "../footage/FootageLoading";

export type FeedDisplayState = "starting" | "replay" | "paused" | "no-recording";

/** Detection-time instant the tile shows; speed 0 holds the frame. */
export interface ArchiveClock {
  timeMs: number;
  speed: number;
  /** Held tiles load a full footage window (so Play starts at once) instead of a few seconds. */
  prefetch?: boolean;
}

export interface CameraFeedProps {
  camera: PoleCamera;
  clock: ArchiveClock | null;
  archive: ArchiveAccess | null;
  className?: string;
  /** Thumbnail-sized: the loading indicator drops its label. */
  compact?: boolean;
  onDisplayState?: (state: FeedDisplayState) => void;
}

/** The archived recording of one camera at the given clock. */
export function CameraFeed({ camera, clock, archive, className, compact = false, onDisplayState }: CameraFeedProps) {
  return (
    <div className={cn("relative overflow-hidden bg-black", className)} style={{ aspectRatio: `${camera.intrinsics.width} / ${camera.intrinsics.height}` }}>
      {clock && archive ? (
        <ArchiveFeed camera={camera} clock={clock} archive={archive} compact={compact} onDisplayState={onDisplayState} />
      ) : (
        <FeedMessage title="No recording" />
      )}
    </div>
  );
}

/** A held tile without prefetch only shows one frame, so it loads this much footage rather than a full window. */
const HELD_WINDOW_MS = 4_000;
/** While playing, the footage is moved back to the clock once they drift further apart than this. */
const DRIFT_LIMIT_MS = 500;

function ArchiveFeed({ camera, clock, archive, compact, onDisplayState }: {
  camera: PoleCamera;
  clock: ArchiveClock;
  archive: ArchiveAccess;
  compact: boolean;
  onDisplayState?: (state: FeedDisplayState) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<ArchivePlayer | null>(null);
  const [status, setStatus] = useState<FootageStatus>("loading");
  const { timeMs, speed } = clock;
  const prefetch = clock.prefetch === true;

  useEffect(() => {
    const player = new ArchivePlayer(videoRef.current!, (next) => setStatus(next));
    playerRef.current = player;
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    playerRef.current?.setSource(camera.id, archive);
  }, [archive, camera.id]);

  useEffect(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (!player || !video) return;
    if (speed > 0) {
      video.playbackRate = speed;
      player.play();
    } else {
      player.pause();
    }
  }, [speed]);

  // Held: show the clock's instant. Playing: the footage runs on its own and is only re-aligned when it drifts.
  // The twin settles scrubbed clocks before they reach the tiles, so every request loads its window at once.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !Number.isFinite(timeMs)) return;
    if (speed === 0) {
      player.show(timeMs, windowAround(timeMs, prefetch ? DEFAULT_WINDOW_MS : HELD_WINDOW_MS));
      return;
    }
    // Also keeps the next footage loading ahead; null while a jump is still loading.
    const shownMs = player.tick().ms;
    if (shownMs !== null && Math.abs(shownMs - timeMs) > DRIFT_LIMIT_MS) player.show(timeMs, windowAround(timeMs));
  }, [archive, camera.id, prefetch, speed, timeMs]);

  const displayState: FeedDisplayState = status === "loading" ? "starting" : status === "ready" ? (speed === 0 ? "paused" : "replay") : "no-recording";
  useEffect(() => onDisplayState?.(displayState), [displayState, onDisplayState]);

  return (
    <>
      <video ref={videoRef} className="block h-full w-full object-cover" muted playsInline data-archive-camera={camera.id} />
      {status === "loading" ? <FootageLoading compact={compact} /> : null}
      {displayState === "no-recording" ? <FeedMessage title="No recording" /> : null}
    </>
  );
}

function FeedMessage({ title }: { title: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70 text-center">
      <VideoOff className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
    </div>
  );
}
