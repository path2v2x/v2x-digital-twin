"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";

import { cn } from "@/app/lib/utils";
import type { ArchiveAccess } from "./archive";
import { ArchivePlayer, type FootageStatus } from "./archive-player";
import { FootageLoading } from "./FootageLoading";
import type { TimeRange } from "../twin/camera-timeline";

/** Show footage at `ms`; `window` is the footage to load if it is not loaded yet. A new object is a new request. */
export interface FootageRequest {
  readonly ms: number;
  readonly window?: TimeRange;
}

export interface FootagePlayerProps {
  channel: string;
  access: ArchiveAccess | null;
  request: FootageRequest | null;
  playing: boolean;
  /** While playing: the instant on screen, once per frame. */
  onTime: (ms: number) => void;
  /** Playback reached the end of the recorded footage. */
  onEnded: () => void;
  /** Shown instead of footage when the archive cannot be used at all. */
  unavailableReason: string | null;
}

export function FootagePlayer({ channel, access, request, playing, onTime, onEnded, unavailableReason }: FootagePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const holdRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<ArchivePlayer | null>(null);
  const [status, setStatus] = useState<{ status: FootageStatus; detail?: string }>({ status: "loading" });
  const [holding, setHolding] = useState(false);
  const reportTime = useEffectEvent(onTime);
  const reportEnded = useEffectEvent(onEnded);

  useEffect(() => {
    const player = new ArchivePlayer(videoRef.current!, (next, detail) => setStatus({ status: next, detail }));
    playerRef.current = player;
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, []);

  // A camera switch restarts the video element: keep the outgoing frame on screen until the new camera has one.
  useEffect(() => {
    const video = videoRef.current;
    const canvas = holdRef.current;
    const player = playerRef.current;
    if (!video || !canvas || !player || !access) return;
    const hasFrame = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
    if (hasFrame) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
    }
    setHolding(player.setSource(channel, access) && hasFrame);
  }, [access, channel]);

  useEffect(() => {
    if (status.status !== "loading") setHolding(false);
  }, [status]);

  useEffect(() => {
    if (request && access) playerRef.current?.show(request.ms, request.window);
  }, [access, request]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (playing) player.play();
    else player.pause();
  }, [playing]);

  // While playing, the video drives the playhead.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const step = () => {
      const tick = playerRef.current?.tick();
      if (tick?.ended) {
        reportEnded();
        return;
      }
      if (tick && tick.ms !== null) reportTime(tick.ms);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const message = unavailableReason
    ?? (status.status === "no-recording" ? "No footage recorded at this time"
      : status.status === "error" ? `Footage could not play: ${status.detail ?? "unknown error"}` : null);

  return (
    <div className="absolute inset-0 bg-black" data-testid="footage" data-status={unavailableReason ? "unavailable" : status.status}>
      <video ref={videoRef} className="absolute inset-0 size-full object-contain" muted playsInline aria-label={`${channel.toUpperCase()} footage`} data-testid="footage-video" />
      <canvas ref={holdRef} aria-hidden="true" className={cn("pointer-events-none absolute inset-0 size-full object-contain", holding ? "visible" : "invisible")} />
      {status.status === "loading" && !unavailableReason ? <FootageLoading /> : null}
      <div
        role="status"
        className={cn(
          "pointer-events-none absolute left-4 top-4 border border-border bg-card/90 px-3 py-1.5 text-sm transition-opacity",
          message ? "opacity-100" : "opacity-0",
          status.status === "error" || unavailableReason ? "text-red-400" : "text-foreground",
        )}
        data-testid="footage-status"
      >
        {message}
      </div>
    </div>
  );
}
