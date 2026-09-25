"use client";

import { useState } from "react";
import { Layers, X } from "lucide-react";
import type { PoleCamera } from "@simforge-oss/maps/camera-rig";

import type { CameraFeedState, CameraFeeds } from "@/app/lib/live-world/camera-feeds";
import type { WorldClock, WorldReplayCapabilities } from "@/app/lib/live-world/types";
import { cn } from "@/app/lib/utils";
import { CameraFeed } from "./CameraFeed";
import type { CameraFrame } from "./camera-view";

interface CameraViewOverlayProps {
  frame: CameraFrame;
  camera: PoleCamera;
  rigLabel: string;
  onExit: () => void;
  feeds: CameraFeeds | null;
  feedState: CameraFeedState;
  clock: WorldClock | null;
  replay: WorldReplayCapabilities | null;
}

const FEED_OPACITIES = [0, 0.5, 1] as const;

/** Dims the world outside the sensor frame; the frame itself stays interactive. */
export function CameraViewOverlay({ frame, camera, rigLabel, onExit, ...feed }: CameraViewOverlayProps) {
  const [feedOpacityIndex, setFeedOpacityIndex] = useState(0);
  const feedOpacity = FEED_OPACITIES[feedOpacityIndex]!;
  const right = frame.left + frame.width;
  const bottom = frame.top + frame.height;
  const mask = "pointer-events-none absolute bg-black/70";

  return (
    <div className="pointer-events-none absolute inset-0 z-10" data-testid="camera-view-overlay" data-camera-id={camera.id}>
      <div className={mask} style={{ left: 0, top: 0, right: 0, height: frame.top }} />
      <div className={mask} style={{ left: 0, top: bottom, right: 0, bottom: 0 }} />
      <div className={mask} style={{ left: 0, top: frame.top, width: frame.left, height: frame.height }} />
      <div className={mask} style={{ left: right, top: frame.top, right: 0, height: frame.height }} />
      {feedOpacity > 0 ? (
        <div className="pointer-events-none absolute" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, opacity: feedOpacity }}>
          <CameraFeed camera={camera} className="h-full w-full" {...feed} />
        </div>
      ) : null}
      <div
        className="pointer-events-none absolute border border-white/50"
        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      />
      <div className="pointer-events-auto absolute flex items-center gap-1" style={{ left: frame.left, top: Math.max(4, frame.top - 30) }}>
        <span className="bg-black/70 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-white">
          {camera.id} <span className="font-normal normal-case tracking-normal text-white/60">· {camera.label ?? rigLabel}</span>
        </span>
        <button
          type="button"
          onClick={() => setFeedOpacityIndex((index) => (index + 1) % FEED_OPACITIES.length)}
          className={cn("flex h-6 items-center gap-1 bg-black/70 px-2 text-[11px] text-white hover:bg-black/90", feedOpacity > 0 && "text-amber-300")}
          title="Overlay the real camera feed on the twin view"
          aria-label={`Camera feed overlay ${Math.round(feedOpacity * 100)} percent`}
        >
          <Layers aria-hidden="true" className="size-3.5" />
          {feedOpacity === 0 ? "Feed off" : `Feed ${Math.round(feedOpacity * 100)}%`}
        </button>
        <button
          type="button"
          onClick={onExit}
          className="flex h-6 items-center gap-1 bg-black/70 px-2 text-[11px] text-white hover:bg-black/90"
          title="Leave camera view (Esc)"
        >
          <X aria-hidden="true" className="size-3.5" /> Esc
        </button>
      </div>
    </div>
  );
}
