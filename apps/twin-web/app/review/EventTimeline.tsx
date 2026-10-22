"use client";

import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { Bike, CarFront, Pause, PersonStanding, Play, Truck, type LucideIcon } from "lucide-react";

import { cn } from "@/app/lib/utils";
import { archiveListUrl, parseArchiveSegments } from "./archive";
import { clampView, formatClock, MINUTE_MS, msToX, pan, rulerTicks, SECOND_MS, uncoveredRanges, xToMs, zoomAround, type TimeRange } from "./camera-timeline";
import { describeEvent, EVENT_KINDS, EVENT_STYLE, parseDetectionEvents, type DetectionEvent, type EventKind } from "./detection-events";

export interface EventTimelineProps {
  /** Latest instant (right bound). */
  nowMs: number;
  /** Earliest instant (left bound). */
  earliestMs: number;
  eventsUrl: string;
  cameraIds: readonly string[];
  archiveListUrlTemplate: string | null;
  archiveOffsetSeconds: number;
  playheadMs: number;
  /** The user clicked (`dragging` false) or dragged the playhead to `ms`. */
  onPlayheadChange: (ms: number, dragging: boolean) => void;
  playing: boolean;
  onPlayPause: () => void;
  focusedEventId: string | null;
  onEventSelect: (event: DetectionEvent) => void;
  onVisibleEventsChange: (events: readonly DetectionEvent[]) => void;
  className?: string;
}

type Drag =
  | { kind: "pan"; pointerId: number; originX: number; originView: TimeRange; moved: boolean }
  | { kind: "scrub"; pointerId: number; originX: number; moved: boolean; eventId: string | null };

const WHEEL_ZOOM_BASE = 1.2;
const WHEEL_NOTCH_PX = 100;
const DRAG_THRESHOLD_PX = 3;
const EVENTS_DEBOUNCE_MS = 150;
const ARCHIVE_DEBOUNCE_MS = 300;
/** Events are fetched for the view plus this share of its span on each side, so panning shows them at once. */
const EVENTS_PAD_FRACTION = 0.25;
const MIN_EVENT_PX = 10;
/** Widths from which a block shows its icon, then its object count. */
const ICON_MIN_PX = 20;
const COUNT_MIN_PX = 44;
const EVENT_ICONS: Readonly<Record<EventKind, LucideIcon>> = { pedestrian: PersonStanding, cyclist: Bike, vehicle: CarFront, large_vehicle: Truck };
const NO_RECORDING_BACKGROUND =
  "repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.22) 0 1px, transparent 1px 6px), hsl(var(--background) / 0.45)";

/** One bar of detected events over all cameras: click an event to play it, click or drag anywhere to scrub. */
export function EventTimeline({
  nowMs,
  earliestMs,
  eventsUrl,
  cameraIds,
  archiveListUrlTemplate,
  archiveOffsetSeconds,
  playheadMs,
  onPlayheadChange,
  playing,
  onPlayPause,
  focusedEventId,
  onEventSelect,
  onVisibleEventsChange,
  className,
}: EventTimelineProps): JSX.Element {
  const bounds = useMemo<TimeRange>(() => ({ startMs: Math.min(earliestMs, nowMs), endMs: nowMs }), [earliestMs, nowMs]);
  const [view, setView] = useState<TimeRange>(bounds);
  const [width, setWidth] = useState(0);
  const [loaded, setLoaded] = useState<{ range: TimeRange; events: DetectionEvent[] } | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [gaps, setGaps] = useState<TimeRange[]>([]);
  const [overEvent, setOverEvent] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const widthRef = useRef(0);
  const boundsRef = useRef(bounds);
  const previousNowRef = useRef(nowMs);
  widthRef.current = width;
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

  // Keep the playhead on screen when it moves from outside (an event click, playback).
  useEffect(() => {
    setView((current) => (playheadMs >= current.startMs && playheadMs <= current.endMs
      ? current
      : pan(current, playheadMs - (current.startMs + current.endMs) / 2, boundsRef.current)));
  }, [playheadMs]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  // Wheel zooms around the cursor; shift or horizontal wheel pans. Native listener so it can preventDefault.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onWheel = (event: WheelEvent) => {
      const trackWidth = widthRef.current;
      if (trackWidth <= 0) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? trackWidth : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const x = event.clientX - track.getBoundingClientRect().left;
      if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        setView((current) => pan(current, delta / trackWidth * (current.endMs - current.startMs), boundsRef.current));
      } else {
        setView((current) => zoomAround(current, xToMs(x, current, trackWidth), WHEEL_ZOOM_BASE ** (dy / WHEEL_NOTCH_PX), boundsRef.current));
      }
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, []);

  const span = view.endMs - view.startMs;
  // Whole minutes (or seconds when zoomed in) keep the request stable while the live edge creeps forward.
  const step = span > 20 * MINUTE_MS ? MINUTE_MS : SECOND_MS;
  const fetchStartMs = Math.floor((view.startMs - span * EVENTS_PAD_FRACTION) / step) * step;
  const fetchEndMs = Math.ceil((view.endMs + span * EVENTS_PAD_FRACTION) / step) * step;
  const needsEvents = !loaded || fetchStartMs < loaded.range.startMs || fetchEndMs > loaded.range.endMs;
  useEffect(() => {
    if (!needsEvents) return;
    const controller = new AbortController();
    const range = { startMs: fetchStartMs, endMs: fetchEndMs };
    const timer = window.setTimeout(() => {
      const url = new URL(eventsUrl, window.location.href);
      url.searchParams.set("start", new Date(range.startMs).toISOString());
      url.searchParams.set("end", new Date(range.endMs).toISOString());
      void fetch(url, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Detections could not load (HTTP ${response.status})`);
          setLoaded({ range, events: parseDetectionEvents(await response.json()) });
          setEventsError(null);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setEventsError(error instanceof Error ? error.message : String(error));
        });
    }, EVENTS_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [eventsUrl, fetchEndMs, fetchStartMs, needsEvents]);

  // Hatched where no camera recorded.
  const archiveStartMs = Math.floor(view.startMs / MINUTE_MS) * MINUTE_MS;
  const archiveEndMs = Math.ceil(view.endMs / MINUTE_MS) * MINUTE_MS;
  const cameraKey = cameraIds.join("\n");
  useEffect(() => {
    if (!archiveListUrlTemplate || cameraKey === "") {
      setGaps([]);
      return;
    }
    const controller = new AbortController();
    const range = { startMs: archiveStartMs, endMs: archiveEndMs };
    const timer = window.setTimeout(() => {
      void Promise.all(cameraKey.split("\n").map(async (camera) => {
        try {
          const response = await fetch(archiveListUrl(archiveListUrlTemplate, camera, range.startMs, range.endMs, archiveOffsetSeconds), { signal: controller.signal });
          if (response.status === 404) return [];
          return response.ok ? parseArchiveSegments(await response.json(), archiveOffsetSeconds) : null;
        } catch {
          return null;
        }
      })).then((listings) => {
        if (controller.signal.aborted) return;
        const known = listings.filter((segments) => segments !== null);
        setGaps(known.length === 0 ? [] : uncoveredRanges(range, known.flat()));
      });
    }, ARCHIVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [archiveEndMs, archiveListUrlTemplate, archiveOffsetSeconds, archiveStartMs, cameraKey]);

  // One row: longer events underneath, so shorter ones drawn over them stay clickable.
  const visibleEvents = useMemo(
    () => (loaded?.events ?? [])
      .filter((event) => event.endMs >= view.startMs && event.startMs <= view.endMs)
      .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs),
    [loaded, view.endMs, view.startMs],
  );
  // Reported once the first request has answered, so an empty list means "nothing detected", not "not loaded yet".
  useEffect(() => {
    if (loaded || eventsError) onVisibleEventsChange(visibleEvents);
  }, [eventsError, loaded, onVisibleEventsChange, visibleEvents]);
  const counts = useMemo(() => {
    const byKind = new Map<EventKind, number>();
    for (const event of visibleEvents) byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
    return byKind;
  }, [visibleEvents]);
  const eventsById = useMemo(() => new Map(visibleEvents.map((event) => [event.id, event])), [visibleEvents]);

  const ticks = useMemo(() => rulerTicks(view, width), [view, width]);
  const playheadX = msToX(playheadMs, view, width);
  const clampToBounds = (ms: number) => Math.max(bounds.startMs, Math.min(bounds.endMs, ms));
  const trackX = (event: ReactPointerEvent) => event.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0);
  const eventIdAt = (event: ReactPointerEvent) => (event.target as HTMLElement).closest<HTMLElement>("[data-event-id]")?.dataset.eventId ?? null;

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, drag: Drag) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = drag;
  };

  const onRulerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    beginDrag(event, { kind: "pan", pointerId: event.pointerId, originX: trackX(event), originView: view, moved: false });
  };

  const onBarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const x = trackX(event);
    if (event.button === 1) return beginDrag(event, { kind: "pan", pointerId: event.pointerId, originX: x, originView: view, moved: false });
    if (event.button !== 0) return;
    beginDrag(event, { kind: "scrub", pointerId: event.pointerId, originX: x, moved: false, eventId: eventIdAt(event) });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const x = trackX(event);
    if (!drag || drag.pointerId !== event.pointerId) {
      if (event.currentTarget.dataset.timelineBar !== undefined) setOverEvent(eventIdAt(event) !== null);
      return;
    }
    if (!drag.moved && Math.abs(x - drag.originX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    if (drag.kind === "pan") {
      const originSpan = drag.originView.endMs - drag.originView.startMs;
      setView(pan(drag.originView, -(x - drag.originX) / Math.max(1, width) * originSpan, bounds));
    } else {
      onPlayheadChange(clampToBounds(xToMs(x, view, width)), true);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved || drag.kind !== "scrub") return;
    const clicked = drag.eventId ? eventsById.get(drag.eventId) : undefined;
    if (clicked) onEventSelect(clicked);
    else onPlayheadChange(clampToBounds(xToMs(trackX(event), view, width)), false);
  };

  const onPointerCancel = () => {
    dragRef.current = null;
  };

  return (
    <div className={cn("flex w-full flex-col border-t border-border bg-card text-xs text-foreground", className)} data-testid="event-timeline">
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onPlayPause}
          aria-label={playing ? "Pause footage" : "Play footage"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-4" />}
        </button>
        <span className="w-[4.75rem] shrink-0 text-sm tabular-nums text-foreground" data-testid="timeline-playhead-clock">{formatClock(playheadMs)}</span>
        <div className="flex min-w-0 items-center gap-3 pl-2" data-testid="timeline-legend">
          {EVENT_KINDS.filter((kind) => kind !== "cyclist" || counts.has(kind)).map((kind) => (
            <span key={kind} className="flex shrink-0 items-center gap-1.5 text-muted-foreground" data-event-kind={kind}>
              <span aria-hidden="true" className="size-2.5" style={{ background: EVENT_STYLE[kind].color }} />
              {EVENT_STYLE[kind].plural}
              <span className="tabular-nums text-foreground">{counts.get(kind) ?? 0}</span>
            </span>
          ))}
        </div>
        {eventsError ? <span role="alert" className="max-w-64 truncate text-red-400" title={eventsError}>{eventsError}</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="hidden text-muted-foreground lg:inline">Click a detection to play it, or drag to scrub</span>
          {span < bounds.endMs - bounds.startMs ? (
            <button type="button" className="h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setView(bounds)} title="Show the whole hour">
              Whole hour
            </button>
          ) : null}
        </div>
      </div>

      <div ref={trackRef} className="relative mx-2 mb-2 select-none overflow-hidden touch-none">
        <div
          className="relative h-5 cursor-grab active:cursor-grabbing"
          onPointerDown={onRulerPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          data-testid="timeline-ruler"
        >
          {ticks.map((tick) => (
            <div key={tick.ms} className="pointer-events-none absolute inset-y-0" style={{ left: msToX(tick.ms, view, width) }}>
              <div className={cn("absolute bottom-0 w-px", tick.major ? "h-full bg-foreground/60" : "h-1.5 bg-muted-foreground/60")} />
              <span className={cn("absolute left-1 top-0 whitespace-nowrap text-[10px] tabular-nums", tick.major ? "font-semibold text-foreground" : "text-muted-foreground")}>
                {tick.label}
              </span>
            </div>
          ))}
        </div>

        <div
          className="relative h-14 border border-border bg-background/60"
          style={{ cursor: overEvent ? "pointer" : "col-resize" }}
          onPointerDown={onBarPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => setOverEvent(false)}
          data-timeline-bar=""
          data-testid="timeline-bar"
        >
          {gaps.map((gap) => {
            const left = Math.max(0, msToX(gap.startMs, view, width));
            const right = Math.min(width, msToX(gap.endMs, view, width));
            return right - left < 0.5 ? null : (
              <div
                key={`${gap.startMs}-${gap.endMs}`}
                className="pointer-events-none absolute inset-y-0"
                style={{ left, width: right - left, background: NO_RECORDING_BACKGROUND }}
                title="No footage recorded"
                data-testid="timeline-no-recording"
              />
            );
          })}
          {visibleEvents.map((event) => {
            const left = msToX(event.startMs, view, width);
            const eventWidth = Math.max(MIN_EVENT_PX, msToX(event.endMs, view, width) - left);
            const focused = event.id === focusedEventId;
            const Icon = EVENT_ICONS[event.kind];
            return (
              <div
                key={event.id}
                className={cn(
                  "absolute inset-y-1.5 flex items-center justify-center gap-1 overflow-hidden text-[11px] font-semibold text-black/80 shadow-[0_0_0_1px_hsl(var(--background))] hover:brightness-125",
                  focused && "z-10 ring-2 ring-white",
                )}
                style={{ left, width: eventWidth, background: EVENT_STYLE[event.kind].color, opacity: focused ? 1 : 0.9 }}
                title={`${EVENT_STYLE[event.kind].label} at ${formatClock(event.startMs)} to ${formatClock(event.endMs)}, ${describeEvent(event)}`}
                data-event-id={event.id}
                data-event-kind={event.kind}
                data-testid="timeline-event"
              >
                {eventWidth >= ICON_MIN_PX ? <Icon aria-hidden="true" className="pointer-events-none size-4 shrink-0" /> : null}
                {eventWidth >= COUNT_MIN_PX && event.objects > 1 ? <span className="pointer-events-none tabular-nums">{event.objects}</span> : null}
              </div>
            );
          })}
          {visibleEvents.length === 0 && loaded ? (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">No moving objects detected in this range</span>
          ) : null}
        </div>

        <div className="pointer-events-none absolute inset-0">
          {playheadX >= 0 && playheadX <= width ? (
            <div className="absolute inset-y-0 w-px bg-red-400" style={{ left: playheadX }} data-testid="timeline-playhead">
              <div className="absolute -left-[5px] top-0 size-0 border-x-[5.5px] border-t-[7px] border-x-transparent border-t-red-400" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
