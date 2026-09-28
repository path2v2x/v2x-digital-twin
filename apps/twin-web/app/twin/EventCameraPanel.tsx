"use client";

import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import type { PoleCamera } from "@simforge-oss/maps/camera-rig";

import { CameraFeed, type ArchiveClock } from "./CameraFeed";
import type { ArchiveAccess } from "./replay-config";

/** Twin and footage panes, identical in size and aspect, centred side by side. */
export interface SplitLayout {
  twin: CSSProperties;
  camera: CSSProperties;
}

const GAP_PX = 4;
const MARGIN_PX = 12;

/**
 * Pane geometry for the split review inside `containerRef`, or null when not
 * splitting. `bottomReservePx` keeps the panes clear of the timeline overlay.
 */
export function useSplitLayout(containerRef: RefObject<HTMLElement | null>, active: boolean, aspect: number, bottomReservePx: number): SplitLayout | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [active, containerRef]);
  if (!active || !size) return null;
  const availableWidth = size.width - 2 * MARGIN_PX - GAP_PX;
  const availableHeight = size.height - 2 * MARGIN_PX - bottomReservePx;
  const paneWidth = Math.max(160, Math.min(availableWidth / 2, availableHeight * aspect));
  const paneHeight = paneWidth / aspect;
  const left = (size.width - 2 * paneWidth - GAP_PX) / 2;
  const top = MARGIN_PX + Math.max(0, (availableHeight - paneHeight) / 2);
  return {
    twin: { left, top, width: paneWidth, height: paneHeight },
    camera: { left: left + paneWidth + GAP_PX, top, width: paneWidth, height: paneHeight },
  };
}

/** The real footage, edge to edge in a pane the same size as the twin's. */
export function CameraPane({ camera, clock, archive, style }: { camera: PoleCamera; clock: ArchiveClock | null; archive: ArchiveAccess | null; style: CSSProperties }) {
  return (
    <section className="absolute overflow-hidden bg-black" style={style} aria-label={`${camera.id} footage`} data-testid="event-camera-panel" data-camera-id={camera.id}>
      <CameraFeed key={camera.id} camera={camera} className="size-full" clock={clock} archive={archive} />
    </section>
  );
}
