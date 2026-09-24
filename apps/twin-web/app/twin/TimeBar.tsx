"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Pause, Play, Radio } from "lucide-react";

import type { WorldClock, WorldReplayCapabilities, WorldSource } from "@/app/lib/live-world/types";
import { cn } from "@/app/lib/utils";
import { coverageTrackBackground, type DetectionCoverageBucket } from "./replay-helpers";

const COVERAGE_BUCKET_SECONDS = 300;
const NOW_REFRESH_MS = 60_000;

interface TimeBarProps {
  source: WorldSource | null;
  capabilities: WorldReplayCapabilities | null;
  clock: WorldClock | null;
  replayError: string | null;
}

/** Scrub the twin through its detection history, or return to live. */
export function TimeBar({ source, capabilities, clock, replayError }: TimeBarProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [draftMs, setDraftMs] = useState<number | null>(null);
  const [coverage, setCoverage] = useState<DetectionCoverageBucket[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const lastPlayingSpeed = useRef(1);
  const available = Boolean(source?.setReplay && source.setLive && capabilities && clock);
  const retentionMs = (capabilities?.retentionHours ?? 72) * 3_600_000;
  const startMs = nowMs - retentionMs;
  const live = clock?.mode !== "replay";
  const replayClockMs = clock?.timeIso ? Date.parse(clock.timeIso) : Number.NaN;
  const displayedMs = draftMs ?? (live || !Number.isFinite(replayClockMs) ? nowMs : replayClockMs);

  useEffect(() => {
    if (clock?.mode === "replay" && clock.speed > 0) lastPlayingSpeed.current = clock.speed;
  }, [clock?.mode, clock?.speed]);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), live ? 1_000 : NOW_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [live]);

  const coverageWindowMs = Math.floor(nowMs / NOW_REFRESH_MS) * NOW_REFRESH_MS;
  useEffect(() => {
    const coverageUrl = capabilities?.coverageUrl;
    if (!coverageUrl) return;
    const controller = new AbortController();
    const url = new URL(coverageUrl);
    url.searchParams.set("start", new Date(coverageWindowMs - retentionMs).toISOString());
    url.searchParams.set("end", new Date(coverageWindowMs).toISOString());
    url.searchParams.set("bucket", String(COVERAGE_BUCKET_SECONDS));
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Detection coverage request failed (${response.status})`);
        const payload = (await response.json()) as { buckets?: DetectionCoverageBucket[] };
        setCoverage(Array.isArray(payload.buckets) ? payload.buckets : []);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLocalError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [capabilities?.coverageUrl, coverageWindowMs, retentionMs]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setLocalError(null);
    try {
      await action();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setDraftMs(null);
    }
  }, []);

  const seek = useCallback((targetMs: number, speed: number) => {
    if (!source?.setReplay) return;
    const clamped = Math.max(startMs, Math.min(Date.now() - 1_000, targetMs));
    void run(() => source.setReplay!({ startIso: new Date(clamped).toISOString(), speed }));
  }, [run, source, startMs]);

  const goLive = useCallback(() => {
    if (!source?.setLive) return;
    void run(() => source.setLive!());
  }, [run, source]);

  const paint = useMemo(() => coverageTrackBackground(coverage, startMs, nowMs), [coverage, nowMs, startMs]);
  const error = replayError ?? localError;
  const shown = new Date(displayedMs);
  const playing = !live && (clock?.speed ?? 0) > 0;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="time-bar">
      <button
        type="button"
        onClick={goLive}
        disabled={!available || busy || live}
        aria-pressed={live}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 border px-2 text-[11px] font-semibold uppercase tracking-wider transition-colors",
          live ? "border-red-500/60 bg-red-500/15 text-red-300" : "border-border text-muted-foreground hover:border-red-500/60 hover:text-red-300",
        )}
        title={live ? "Showing the live twin" : "Return to live"}
      >
        <Radio aria-hidden="true" className={cn("size-3.5", live && "animate-pulse")} />
        Live
      </button>
      <button
        type="button"
        disabled={!available || busy}
        onClick={() => (live ? seek(Date.now() - 10 * 60_000, 1) : seek(displayedMs, playing ? 0 : lastPlayingSpeed.current))}
        className="flex size-7 shrink-0 items-center justify-center border border-border text-foreground hover:bg-muted disabled:opacity-40"
        aria-label={live ? "Replay the last 10 minutes" : playing ? "Pause history" : "Play history"}
        title={live ? "Replay the last 10 minutes" : playing ? "Pause" : "Play"}
      >
        {live ? <History aria-hidden="true" className="size-3.5" /> : playing ? <Pause aria-hidden="true" className="size-3.5" /> : <Play aria-hidden="true" className="size-3.5" />}
      </button>
      <input
        type="range"
        min={startMs}
        max={nowMs}
        step={1_000}
        value={Math.max(startMs, Math.min(nowMs, displayedMs))}
        disabled={!available || busy}
        onChange={(event) => setDraftMs(Number(event.currentTarget.value))}
        onPointerUp={(event) => seek(Number(event.currentTarget.value), live ? 1 : clock?.speed ?? 1)}
        onKeyUp={(event) => {
          if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") seek(Number(event.currentTarget.value), live ? 1 : clock?.speed ?? 1);
        }}
        className="h-1.5 min-w-24 flex-1 cursor-pointer appearance-none accent-primary disabled:cursor-default disabled:opacity-40"
        style={{ background: paint }}
        aria-label={`Twin time, last ${capabilities?.retentionHours ?? 72} hours`}
        aria-valuetext={shown.toLocaleString()}
      />
      <div className="w-36 shrink-0 text-right text-[11px] leading-tight tabular-nums" data-testid="time-bar-clock">
        <div className={cn("font-medium", live && draftMs === null ? "text-red-300" : "text-foreground")}>
          {live && draftMs === null ? "Live" : shown.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </div>
        <div className="text-muted-foreground">
          {shown.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
          {!live && clock && clock.speed !== 1 && clock.speed > 0 ? ` · ${clock.speed}×` : ""}
        </div>
      </div>
      {error ? (
        <span role="alert" className="max-w-48 truncate text-[11px] text-destructive" title={error}>{error}</span>
      ) : null}
    </div>
  );
}
