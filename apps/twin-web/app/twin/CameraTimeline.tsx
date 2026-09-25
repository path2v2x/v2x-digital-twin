"use client";

import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, Clapperboard, Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";

import { cn } from "@/app/lib/utils";
import {
  chooseBucketSeconds,
  clampSelection,
  clampView,
  coverageWindow,
  densityAlpha,
  fitLatest,
  formatSelection,
  formatViewRange,
  HOUR_MS,
  MINUTE_MS,
  moveSelection,
  msToX,
  pan,
  rulerTicks,
  SECOND_MS,
  uncoveredRanges,
  xToMs,
  zoomAround,
  type TimeRange,
} from "./camera-timeline";
import { archiveListUrl, parseArchiveSegments } from "./replay-helpers";

export type TimeSelection = TimeRange;

export interface CameraTimelineProps {
  cameras: readonly { id: string; label: string }[];
  /** Latest selectable instant (right bound). */
  nowMs: number;
  /** Retention bound (left bound). */
  earliestMs: number;
  coverageUrl: string;
  archiveListUrlTemplate: string | null;
  archiveOffsetSeconds: number;
  playheadMs: number;
  onPlayheadChange: (ms: number) => void;
  selection: TimeSelection | null;
  onSelectionChange: (selection: TimeSelection | null) => void;
  maxSelectionMs: number;
  onSimulate: () => void;
  simulateDisabledReason: string | null;
  className?: string;
}

interface CoverageStrip {
  bucketMs: number;
  buckets: { startMs: number; cameras: Record<string, number> }[];
}

interface CameraGaps {
  /** Recording gaps inside `range`, per camera; a camera whose listing failed is absent. */
  gaps: Record<string, TimeRange[]>;
  range: TimeRange;
}

type Drag =
  | { kind: "pan"; pointerId: number; originX: number; originView: TimeRange; moved: boolean }
  | { kind: "select"; pointerId: number; originX: number; anchorMs: number; moved: boolean }
  | { kind: "move"; pointerId: number; originX: number; originMs: number; originSelection: TimeRange; moved: boolean };

type SelectionHit = "start" | "end" | "body" | null;

const PAGE_MS = 12 * HOUR_MS;
const WHEEL_ZOOM_BASE = 1.2;
const WHEEL_NOTCH_PX = 100;
const BUTTON_ZOOM_FACTOR = 2;
const DRAG_THRESHOLD_PX = 3;
const EDGE_HIT_PX = 6;
const COVERAGE_DEBOUNCE_MS = 150;
const ARCHIVE_DEBOUNCE_MS = 300;
const ROW_INSET_PX = 3;
const NO_RECORDING_BACKGROUND =
  "repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.22) 0 1px, transparent 1px 6px), hsl(var(--background) / 0.45)";

/** Video-editor style range picker over the recorded camera history. */
export function CameraTimeline({
  cameras,
  nowMs,
  earliestMs,
  coverageUrl,
  archiveListUrlTemplate,
  archiveOffsetSeconds,
  playheadMs,
  onPlayheadChange,
  selection,
  onSelectionChange,
  maxSelectionMs,
  onSimulate,
  simulateDisabledReason,
  className,
}: CameraTimelineProps): JSX.Element {
  const bounds = useMemo<TimeRange>(() => ({ startMs: Math.min(earliestMs, nowMs), endMs: nowMs }), [earliestMs, nowMs]);
  const [view, setView] = useState<TimeRange>(() => fitLatest(bounds));
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [coverage, setCoverage] = useState<CoverageStrip | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<CameraGaps | null>(null);
  const [hoverCursor, setHoverCursor] = useState("crosshair");
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef(new Map<string, HTMLCanvasElement>());
  const dragRef = useRef<Drag | null>(null);
  const widthRef = useRef(0);
  const boundsRef = useRef(bounds);
  const previousNowRef = useRef(nowMs);
  widthRef.current = size.width;
  boundsRef.current = bounds;

  // Follow the live edge while the view is pinned to it; always stay inside the bounds.
  useEffect(() => {
    const previousNow = previousNowRef.current;
    previousNowRef.current = bounds.endMs;
    setView((current) => {
      const shift = current.endMs >= previousNow - 1 ? bounds.endMs - previousNow : 0;
      const next = clampView({ startMs: current.startMs + shift, endMs: current.endMs + shift }, bounds);
      return next.startMs === current.startMs && next.endMs === current.endMs ? current : next;
    });
  }, [bounds]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  // Wheel zooms around the cursor; shift or horizontal wheel pans. Native listener so it can preventDefault.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onWheel = (event: WheelEvent) => {
      const width = widthRef.current;
      if (width <= 0) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const x = event.clientX - track.getBoundingClientRect().left;
      if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        setView((current) => pan(current, delta / width * (current.endMs - current.startMs), boundsRef.current));
      } else {
        setView((current) => zoomAround(current, xToMs(x, current, width), WHEEL_ZOOM_BASE ** (dy / WHEEL_NOTCH_PX), boundsRef.current));
      }
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, []);

  const bucketSeconds = chooseBucketSeconds(view.endMs - view.startMs, size.width);
  const coverageRange = coverageWindow(view, bucketSeconds);
  useEffect(() => {
    if (size.width <= 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const url = new URL(coverageUrl, window.location.href);
      url.searchParams.set("start", new Date(coverageRange.startMs).toISOString());
      url.searchParams.set("end", new Date(coverageRange.endMs).toISOString());
      url.searchParams.set("bucket", String(bucketSeconds));
      url.searchParams.set("by", "camera");
      void fetch(url, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Detection coverage request failed (${response.status})`);
          const payload = (await response.json()) as { buckets?: { start?: unknown; cameras?: Record<string, { detections?: unknown }> }[] };
          const buckets = (Array.isArray(payload.buckets) ? payload.buckets : []).flatMap((bucket) => {
            const startMs = typeof bucket.start === "string" ? Date.parse(bucket.start) : Number.NaN;
            if (!Number.isFinite(startMs)) return [];
            const counts: Record<string, number> = {};
            for (const [camera, value] of Object.entries(bucket.cameras ?? {})) {
              if (typeof value?.detections === "number") counts[camera] = value.detections;
            }
            return [{ startMs, cameras: counts }];
          });
          setCoverage({ bucketMs: bucketSeconds * SECOND_MS, buckets });
          setCoverageError(null);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setCoverageError(error instanceof Error ? error.message : String(error));
        });
    }, COVERAGE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [bucketSeconds, coverageRange.endMs, coverageRange.startMs, coverageUrl, size.width]);

  // Whole minutes keep the listing stable while the live edge creeps forward.
  const archiveRange = coverageWindow(view, 60);
  const cameraIds = cameras.map((camera) => camera.id).join("\n");
  useEffect(() => {
    if (!archiveListUrlTemplate || archiveRange.endMs - archiveRange.startMs > PAGE_MS + 2 * MINUTE_MS) {
      setRecordings(null);
      return;
    }
    const controller = new AbortController();
    const range = { startMs: archiveRange.startMs, endMs: archiveRange.endMs };
    const timer = window.setTimeout(() => {
      void Promise.all(cameraIds.split("\n").filter(Boolean).map(async (camera) => {
        try {
          const response = await fetch(
            archiveListUrl(archiveListUrlTemplate, camera, range.startMs, range.endMs, archiveOffsetSeconds),
            { signal: controller.signal },
          );
          const segments = response.status === 404 ? [] : response.ok ? parseArchiveSegments(await response.json(), archiveOffsetSeconds) : null;
          return [camera, segments === null ? null : uncoveredRanges(range, segments)] as const;
        } catch {
          return [camera, null] as const;
        }
      })).then((entries) => {
        if (controller.signal.aborted) return;
        const gaps: Record<string, TimeRange[]> = {};
        for (const [camera, cameraGaps] of entries) if (cameraGaps) gaps[camera] = cameraGaps;
        setRecordings({ gaps, range });
      });
    }, ARCHIVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [archiveListUrlTemplate, archiveOffsetSeconds, archiveRange.endMs, archiveRange.startMs, cameraIds]);

  // Heat strips: one canvas per camera row, shared log scale over the visible buckets.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || size.width <= 0) return;
    const primary = getComputedStyle(root).getPropertyValue("--primary").trim() || "53 78% 58%";
    const dpr = window.devicePixelRatio || 1;
    const visible = (coverage?.buckets ?? []).filter((bucket) => bucket.startMs + coverage!.bucketMs > view.startMs && bucket.startMs < view.endMs);
    let peak = 0;
    for (const bucket of visible) for (const count of Object.values(bucket.cameras)) peak = Math.max(peak, count);
    for (const camera of cameras) {
      const canvas = canvasRefs.current.get(camera.id);
      const context = canvas?.getContext("2d");
      if (!canvas || !context) continue;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!coverage) continue;
      const top = ROW_INSET_PX * dpr;
      const height = Math.max(1, canvas.height - 2 * top);
      for (const bucket of visible) {
        const alpha = densityAlpha(bucket.cameras[camera.id] ?? 0, peak);
        if (alpha === 0) continue;
        const left = msToX(bucket.startMs, view, size.width) * dpr;
        const right = msToX(bucket.startMs + coverage.bucketMs, view, size.width) * dpr;
        context.fillStyle = `hsl(${primary} / ${alpha.toFixed(3)})`;
        context.fillRect(left, top, Math.max(1, right - left), height);
      }
    }
  }, [cameras, coverage, size.height, size.width, view]);

  const width = size.width;
  const span = view.endMs - view.startMs;
  const ticks = useMemo(() => rulerTicks(view, width), [view, width]);
  const playheadX = msToX(playheadMs, view, width);
  const selectionLeft = selection ? msToX(selection.startMs, view, width) : 0;
  const selectionRight = selection ? msToX(selection.endMs, view, width) : 0;
  const clampToBounds = (ms: number) => Math.max(bounds.startMs, Math.min(bounds.endMs, ms));
  const trackX = (event: ReactPointerEvent) => event.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0);

  const hitSelection = (x: number): SelectionHit => {
    if (!selection) return null;
    if (Math.abs(x - selectionLeft) <= EDGE_HIT_PX) return "start";
    if (Math.abs(x - selectionRight) <= EDGE_HIT_PX) return "end";
    return x > selectionLeft && x < selectionRight ? "body" : null;
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, drag: Drag) => {
    event.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = drag;
  };

  const onRulerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    beginDrag(event, { kind: "pan", pointerId: event.pointerId, originX: trackX(event), originView: view, moved: false });
  };

  const onRowsPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const x = trackX(event);
    const common = { pointerId: event.pointerId, originX: x, moved: false };
    if (event.button === 1) return beginDrag(event, { kind: "pan", ...common, originView: view });
    if (event.button !== 0) return;
    const hit = hitSelection(x);
    if (selection && hit === "start") return beginDrag(event, { kind: "select", ...common, anchorMs: selection.endMs });
    if (selection && hit === "end") return beginDrag(event, { kind: "select", ...common, anchorMs: selection.startMs });
    if (selection && hit === "body") {
      setHoverCursor("grabbing");
      return beginDrag(event, { kind: "move", ...common, originMs: xToMs(x, view, width), originSelection: selection });
    }
    beginDrag(event, { kind: "select", ...common, anchorMs: clampToBounds(xToMs(x, view, width)) });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const x = trackX(event);
    if (!drag || drag.pointerId !== event.pointerId) {
      if (event.currentTarget.dataset.timelineRows !== undefined) {
        const hit = hitSelection(x);
        setHoverCursor(hit === "start" || hit === "end" ? "ew-resize" : hit === "body" ? "grab" : "crosshair");
      }
      return;
    }
    if (!drag.moved && Math.abs(x - drag.originX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    if (drag.kind === "pan") {
      const originSpan = drag.originView.endMs - drag.originView.startMs;
      setView(pan(drag.originView, -(x - drag.originX) / Math.max(1, width) * originSpan, bounds));
    } else if (drag.kind === "select") {
      onSelectionChange(clampSelection(drag.anchorMs, xToMs(x, view, width), maxSelectionMs, bounds));
    } else {
      onSelectionChange(moveSelection(drag.originSelection, xToMs(x, view, width) - drag.originMs, bounds));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag.moved) {
      onPlayheadChange(clampToBounds(xToMs(trackX(event), view, width)));
    } else if (drag.kind === "select" && selection && selection.endMs <= selection.startMs) {
      onSelectionChange(null);
    }
  };

  const onPointerCancel = () => {
    dragRef.current = null;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && selection) {
      event.preventDefault();
      dragRef.current = null;
      onSelectionChange(null);
    }
  };

  const zoomButton = (factor: number) => {
    const anchor = playheadMs >= view.startMs && playheadMs <= view.endMs ? playheadMs : view.startMs + span / 2;
    setView(zoomAround(view, anchor, factor, bounds));
  };

  const atStart = view.startMs <= bounds.startMs;
  const atEnd = view.endMs >= bounds.endMs;
  const spanLabel = span >= HOUR_MS ? `${+(span / HOUR_MS).toFixed(1)} h` : span >= MINUTE_MS ? `${+(span / MINUTE_MS).toFixed(1)} min` : `${Math.round(span / SECOND_MS)} s`;
  const headerButton = "flex h-7 shrink-0 items-center gap-1 border border-border px-2 text-[11px] text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40";

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn("flex h-[224px] w-full flex-col border-t border-border bg-card text-xs text-foreground outline-none", className)}
      data-testid="camera-timeline"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <button type="button" className={headerButton} onClick={() => setView(pan(view, -PAGE_MS, bounds))} disabled={atStart} aria-label="Back 12 hours" title="Back 12 hours">
          <ChevronLeft aria-hidden="true" className="size-3.5" />−12 h
        </button>
        <button type="button" className={headerButton} onClick={() => setView(pan(view, PAGE_MS, bounds))} disabled={atEnd} aria-label="Forward 12 hours" title="Forward 12 hours">
          +12 h<ChevronRight aria-hidden="true" className="size-3.5" />
        </button>
        <div className="min-w-0 truncate tabular-nums text-muted-foreground" data-testid="timeline-view-range" title="Visible range">
          {formatViewRange(view)}
          <span className="ml-1.5 text-muted-foreground/70">· {spanLabel}</span>
        </div>
        <div className="ml-1 flex shrink-0 items-center">
          <button type="button" className={cn(headerButton, "px-1.5")} onClick={() => zoomButton(BUTTON_ZOOM_FACTOR)} aria-label="Zoom out" title="Zoom out">
            <ZoomOut aria-hidden="true" className="size-3.5" />
          </button>
          <button type="button" className={cn(headerButton, "-ml-px px-1.5")} onClick={() => zoomButton(1 / BUTTON_ZOOM_FACTOR)} aria-label="Zoom in" title="Zoom in">
            <ZoomIn aria-hidden="true" className="size-3.5" />
          </button>
          <button type="button" className={cn(headerButton, "-ml-px")} onClick={() => setView(fitLatest(bounds))} aria-label="Fit the last 12 hours" title="Fit the last 12 hours">
            <Maximize2 aria-hidden="true" className="size-3.5" />Fit 12 h
          </button>
        </div>
        {coverageError ? (
          <span role="alert" className="max-w-56 truncate text-[11px] text-destructive" title={coverageError}>{coverageError}</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {selection ? (
            <div className="flex items-center gap-1 border border-primary/50 bg-primary/10 py-0.5 pl-2 pr-0.5 tabular-nums text-foreground" data-testid="timeline-selection-readout">
              {formatSelection(selection)}
              <button
                type="button"
                className="flex size-5 items-center justify-center text-muted-foreground hover:text-foreground"
                onClick={() => onSelectionChange(null)}
                aria-label="Clear selection"
                title="Clear selection (Esc)"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </div>
          ) : (
            <span className="text-muted-foreground">Drag across the cameras to select up to {Math.round(maxSelectionMs / SECOND_MS)} s</span>
          )}
          <button
            type="button"
            onClick={onSimulate}
            disabled={simulateDisabledReason !== null}
            title={simulateDisabledReason ?? undefined}
            aria-label="Simulate the selected window"
            className="flex h-7 items-center gap-1.5 bg-primary px-3 text-[11px] font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Simulate
            <Clapperboard aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-24 shrink-0 flex-col border-r border-border">
          <div className="h-6 shrink-0 border-b border-border" />
          {cameras.map((camera) => (
            <div key={camera.id} className="flex min-h-0 flex-1 items-center border-b border-border px-3 last:border-b-0">
              <span className="truncate text-[11px] font-medium text-muted-foreground" title={camera.label}>{camera.label}</span>
            </div>
          ))}
        </div>

        <div ref={trackRef} className="relative flex min-w-0 flex-1 select-none flex-col overflow-hidden touch-none">
          <div
            className="relative h-6 shrink-0 cursor-grab border-b border-border bg-background/40 active:cursor-grabbing"
            onPointerDown={onRulerPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            data-testid="timeline-ruler"
          >
            {ticks.map((tick) => (
              <div key={tick.ms} className="pointer-events-none absolute inset-y-0" style={{ left: msToX(tick.ms, view, width) }}>
                <div className={cn("absolute bottom-0 w-px", tick.major ? "h-full bg-foreground/60" : "h-2 bg-muted-foreground/60")} />
                <span className={cn("absolute left-1 top-0.5 whitespace-nowrap text-[10px] tabular-nums", tick.major ? "font-semibold text-foreground" : "text-muted-foreground")}>
                  {tick.label}
                </span>
              </div>
            ))}
          </div>

          <div
            className="relative flex min-h-0 flex-1 flex-col"
            style={{ cursor: hoverCursor }}
            onPointerDown={onRowsPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            data-timeline-rows=""
          >
            {cameras.map((camera) => {
              const gaps = recordings?.gaps[camera.id] ?? [];
              return (
                <div key={camera.id} className="relative min-h-0 flex-1 border-b border-border last:border-b-0" data-camera-row={camera.id}>
                  <canvas
                    ref={(canvas) => {
                      if (canvas) canvasRefs.current.set(camera.id, canvas);
                      else canvasRefs.current.delete(camera.id);
                    }}
                    className="pointer-events-none absolute inset-0 size-full"
                  />
                  {gaps.map((gap) => {
                    const left = Math.max(0, msToX(gap.startMs, view, width));
                    const right = Math.min(width, msToX(gap.endMs, view, width));
                    return right - left < 0.5 ? null : (
                      <div
                        key={`${gap.startMs}-${gap.endMs}`}
                        className="pointer-events-none absolute inset-y-0"
                        style={{ left, width: right - left, background: NO_RECORDING_BACKGROUND }}
                        title="No recording"
                        data-testid="timeline-no-recording"
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="pointer-events-none absolute inset-0">
            {ticks.map((tick) => (
              <div
                key={tick.ms}
                className={cn("absolute bottom-0 top-6 w-px", tick.major ? "bg-foreground/25" : "bg-border/60")}
                style={{ left: msToX(tick.ms, view, width) }}
              />
            ))}
            {selection && selectionRight > 0 && selectionLeft < width ? (
              <div
                className="absolute bottom-0 top-6 border-x-2 border-primary bg-primary/20"
                style={{ left: selectionLeft - 1, width: Math.max(2, selectionRight - selectionLeft + 2) }}
                data-testid="timeline-selection"
              >
                <div className="absolute -left-[5px] top-1/2 h-6 w-2 -translate-y-1/2 bg-primary" />
                <div className="absolute -right-[5px] top-1/2 h-6 w-2 -translate-y-1/2 bg-primary" />
              </div>
            ) : null}
            {playheadX >= 0 && playheadX <= width ? (
              <div className="absolute inset-y-0 w-px bg-red-400" style={{ left: playheadX }} data-testid="timeline-playhead">
                <div className="absolute -left-[5px] top-0 size-0 border-x-[5.5px] border-t-[7px] border-x-transparent border-t-red-400" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
