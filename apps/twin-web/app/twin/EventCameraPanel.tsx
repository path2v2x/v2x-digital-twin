"use client";

import type { PoleCamera } from "@simforge-oss/maps/camera-rig";
import { Pause, Play, X } from "lucide-react";

import { cn } from "@/app/lib/utils";
import { CameraFeed, type ArchiveClock } from "./CameraFeed";
import { formatClock } from "./camera-timeline";
import { describeEvent, EVENT_STYLE, type DetectionEvent } from "./detection-events";
import type { ArchiveAccess } from "./replay-config";

interface EventCameraPanelProps {
  event: DetectionEvent;
  cameras: readonly PoleCamera[];
  cameraId: string;
  onCameraChange: (cameraId: string) => void;
  clock: ArchiveClock | null;
  archive: ArchiveAccess | null;
  playing: boolean;
  onPlayPause: () => void;
  onClose: () => void;
}

/** Right half of the split view: one camera's footage of the focused event, large. */
export function EventCameraPanel({ event, cameras, cameraId, onCameraChange, clock, archive, playing, onPlayPause, onClose }: EventCameraPanelProps) {
  const camera = cameras.find((candidate) => candidate.id === cameraId) ?? cameras[0] ?? null;
  const eventCameras = new Set(event.cameras);
  const style = EVENT_STYLE[event.kind];
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col border-l border-border bg-black" aria-label="Event camera" data-testid="event-camera-panel" data-camera-id={camera?.id}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-xs">
        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: style.color }} />
        <span className="truncate font-medium text-foreground">{style.label}</span>
        <span className="truncate tabular-nums text-muted-foreground">
          {formatClock(event.startMs)}–{formatClock(event.endMs)} · {describeEvent(event)}
        </span>
        <div className="ml-auto flex shrink-0 items-center" role="group" aria-label="Camera">
          {cameras.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => onCameraChange(candidate.id)}
              aria-pressed={candidate.id === camera?.id}
              title={eventCameras.has(candidate.id) ? `${candidate.id.toUpperCase()} saw this event` : `${candidate.id.toUpperCase()} did not see this event`}
              className={cn(
                "-ml-px h-7 border border-border px-2 text-[11px] font-medium uppercase first:ml-0",
                candidate.id === camera?.id ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                !eventCameras.has(candidate.id) && candidate.id !== camera?.id && "opacity-50",
              )}
            >
              {candidate.id}
            </button>
          ))}
        </div>
        <button type="button" onClick={onPlayPause} className="flex size-7 items-center justify-center text-foreground hover:bg-muted" aria-label={playing ? "Pause footage" : "Play footage"}>
          {playing ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-4" />}
        </button>
        <button type="button" onClick={onClose} className="flex size-7 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close camera view" title="Close (Esc)">
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-2">
        {camera ? <CameraFeed key={camera.id} camera={camera} className="max-h-full w-full" clock={clock} archive={archive} /> : null}
      </div>
    </section>
  );
}
