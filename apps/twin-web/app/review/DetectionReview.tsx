"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/app/lib/utils";
import { eventFootageWindow, LEAD_IN_MS, windowAround } from "./archive";
import type { DetectionEvent } from "./detection-events";
import { EventTimeline } from "./EventTimeline";
import { FootagePlayer, type FootageRequest } from "./FootagePlayer";
import { DETECTION_EVENTS_URL, useArchiveAccess } from "./replay-config";

/** The four pole cameras on the Richmond Field Station mast. */
const CAMERAS = ["ch1", "ch2", "ch3", "ch4"];
/** The timeline covers the past hour. */
const TIMELINE_SPAN_MS = 60 * 60_000;
/** Arrow keys step the playhead by this much. */
const ARROW_STEP_MS = 1_000;
/** With no detection to open on, start this far before now. */
const START_BEFORE_NOW_MS = 60_000;

export function DetectionReview() {
  const archive = useArchiveAccess();
  // The page is prerendered at build time, so anything clock-dependent waits for the browser's clock.
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [camera, setCamera] = useState(CAMERAS[0]!);
  const [playheadMs, setPlayheadMs] = useState(() => Date.now() - START_BEFORE_NOW_MS);
  const [playing, setPlaying] = useState(false);
  const [request, setRequest] = useState<FootageRequest | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);
  const [visibleEvents, setVisibleEvents] = useState<readonly DetectionEvent[]>([]);
  const openedRef = useRef(false);
  const playheadRef = useRef(playheadMs);
  playheadRef.current = playheadMs;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  /** Whether playback resumes when the drag in progress ends; null when not dragging. */
  const resumeAfterDragRef = useRef<boolean | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // The page opens paused on the latest detection, just before it starts, on the camera that saw most of it.
  const openEvent = useCallback((event: DetectionEvent) => {
    const ms = event.startMs - LEAD_IN_MS;
    setCamera((current) => event.cameras[0] ?? current);
    setFocusedEventId(event.id);
    setPlayheadMs(ms);
    setRequest({ ms, window: eventFootageWindow(event) });
  }, []);

  // Dragging pauses playback; footage follows once the pointer settles.
  const scrub = useCallback((ms: number) => {
    resumeAfterDragRef.current ??= playingRef.current;
    setPlaying(false);
    setPlayheadMs(ms);
    setRequest({ ms });
  }, []);

  // A click, the end of a drag or an arrow key: show exactly `ms` at once and keep playing if it was.
  // A clicked detection the current camera did not see switches to a camera that did.
  const seek = useCallback((ms: number, clicked: DetectionEvent | null = null) => {
    const resume = resumeAfterDragRef.current;
    resumeAfterDragRef.current = null;
    if (resume !== null) setPlaying(resume);
    if (clicked) setCamera((current) => (clicked.cameras.includes(current) ? current : clicked.cameras[0] ?? current));
    setPlayheadMs(ms);
    setRequest({ ms, window: windowAround(ms) });
    setFocusedEventId(clicked?.id ?? visibleEvents.find((event) => event.startMs <= ms && ms <= event.endMs)?.id ?? null);
  }, [visibleEvents]);

  const switchCamera = useCallback((id: string) => {
    setCamera(id);
    setRequest({ ms: playheadRef.current });
  }, []);

  // Open on `?at=` (and `?camera=`) when given, otherwise on the most recent detection of the hour.
  const onVisibleEventsChange = useCallback((events: readonly DetectionEvent[]) => {
    setVisibleEvents(events);
    if (openedRef.current) return;
    openedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const cameraParam = params.get("camera");
    if (cameraParam && CAMERAS.includes(cameraParam)) setCamera(cameraParam);
    const at = Date.parse(params.get("at") ?? "");
    const latest = events.reduce<DetectionEvent | null>((best, event) => (!best || event.startMs > best.startMs ? event : best), null);
    if (Number.isFinite(at)) {
      setPlayheadMs(at);
      setRequest({ ms: at });
    } else if (latest) {
      openEvent(latest);
    } else {
      setRequest({ ms: playheadRef.current });
    }
  }, [openEvent]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === " ") {
        // A focused button already toggles on Space.
        if (target?.closest("button")) return;
        event.preventDefault();
        setPlaying((current) => !current);
      } else if (CAMERAS[Number(event.key) - 1]) {
        event.preventDefault();
        switchCamera(CAMERAS[Number(event.key) - 1]!);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        seek(playheadRef.current + (event.key === "ArrowLeft" ? -ARROW_STEP_MS : ARROW_STEP_MS));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [seek, switchCamera]);

  const unavailableReason = archive.error
    ? `Recordings are unavailable: ${archive.error}`
    : archive.loaded && !archive.access ? "No footage archive is configured on the server" : null;

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="font-display text-base font-semibold">Detections</h1>
        <span className="truncate text-sm text-muted-foreground">Richmond Field Station</span>
        <nav className="ml-auto flex items-center gap-1" aria-label="Cameras">
          {CAMERAS.map((id, index) => {
            const count = visibleEvents.filter((event) => event.cameras.includes(id)).length;
            const active = id === camera;
            return (
              <button
                key={id}
                type="button"
                onClick={() => switchCamera(id)}
                aria-pressed={active}
                title={`Show ${id.toUpperCase()} (key ${index + 1})`}
                className={cn(
                  "flex h-8 items-center gap-2 border px-3 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                )}
                data-camera-id={id}
              >
                {id.toUpperCase()}
                <span className={cn("min-w-4 text-xs", count > 0 ? "text-primary" : "text-muted-foreground/60")}>{count}</span>
              </button>
            );
          })}
        </nav>
      </header>
      <main className="relative min-h-0 flex-1">
        <FootagePlayer
          channel={camera}
          access={archive.access}
          request={request}
          playing={playing}
          onTime={setPlayheadMs}
          onEnded={() => setPlaying(false)}
          unavailableReason={unavailableReason}
        />
      </main>
      {nowMs === null ? (
        <div className="h-[124px] shrink-0 border-t border-border bg-card" aria-hidden="true" />
      ) : (
        <EventTimeline
          nowMs={nowMs}
          earliestMs={nowMs - TIMELINE_SPAN_MS}
          eventsUrl={DETECTION_EVENTS_URL}
          cameraIds={CAMERAS}
          archiveListUrlTemplate={archive.access?.listUrlTemplate ?? null}
          archiveOffsetSeconds={archive.access?.offsetSeconds ?? 0}
          playheadMs={playheadMs}
          onScrub={scrub}
          onSeek={seek}
          playing={playing}
          onPlayPause={() => setPlaying((current) => !current)}
          focusedEventId={focusedEventId}
          onVisibleEventsChange={onVisibleEventsChange}
        />
      )}
    </div>
  );
}
