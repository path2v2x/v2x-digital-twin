"use client";

import { useState } from "react";
import type { PoleCamera } from "@simforge-oss/maps/camera-rig";

import { cn } from "@/app/lib/utils";
import { CameraFeed, type ArchiveClock, type FeedDisplayState } from "./CameraFeed";
import type { ArchiveAccess } from "./replay-config";

export interface StripCamera {
  readonly key: string;
  readonly camera: PoleCamera;
  readonly rigLabel: string;
  /** False when the rig's pole is missing from the map, so the view cannot be aligned. */
  readonly alignable: boolean;
}

interface CameraStripProps {
  cameras: readonly StripCamera[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  clock: ArchiveClock | null;
  archive: ArchiveAccess | null;
  error: string | null;
}

/** Permanently open, slim column of recorded camera frames; a click looks through that camera. */
export function CameraStrip({ cameras, activeKey, onSelect, clock, archive, error }: CameraStripProps) {
  return (
    <aside className="flex h-full w-52 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border bg-background/95 p-2" aria-label="Cameras" data-testid="camera-strip">
      {cameras.map(({ key, camera, rigLabel, alignable }) => (
        <CameraTile
          key={key}
          camera={camera}
          rigLabel={rigLabel}
          active={key === activeKey}
          alignable={alignable}
          onSelect={() => onSelect(key)}
          clock={clock}
          archive={archive}
        />
      ))}
      {cameras.length === 0 ? (
        <p className="px-1 py-4 text-center text-[11px] text-muted-foreground" role={error ? "alert" : "status"}>
          {error ?? "No cameras configured."}
        </p>
      ) : null}
    </aside>
  );
}

function CameraTile({ camera, rigLabel, active, alignable, onSelect, clock, archive }: {
  camera: PoleCamera;
  rigLabel: string;
  active: boolean;
  alignable: boolean;
  onSelect: () => void;
  clock: ArchiveClock | null;
  archive: ArchiveAccess | null;
}) {
  const [display, setDisplay] = useState<FeedDisplayState>("starting");
  const label = camera.label ?? camera.id;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!alignable}
      aria-pressed={active}
      title={alignable ? (active ? `Leave ${label} view` : `Look through ${label}`) : `${label}: pole ${rigLabel} is not in this map`}
      className={cn(
        "group relative block w-full shrink-0 border text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40",
        !alignable && "cursor-not-allowed opacity-60",
      )}
      data-camera-id={camera.id}
    >
      <CameraFeed camera={camera} className="w-full" onDisplayState={setDisplay} clock={clock} archive={archive} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-4">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            display === "replay" ? "bg-amber-400" : display === "paused" ? "bg-sky-400" : "bg-muted-foreground",
          )}
        />
        <span className="truncate text-[11px] font-medium text-white">{camera.id.toUpperCase()}</span>
        <span className="ml-auto truncate text-[10px] text-white/60">{active ? "Viewing" : display === "replay" ? "Playing" : display === "paused" ? "Paused" : ""}</span>
      </div>
    </button>
  );
}
