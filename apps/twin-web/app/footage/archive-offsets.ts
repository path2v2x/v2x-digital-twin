import type { TimeRange } from "../twin/camera-timeline";

/** How far the recorded footage ran behind detection time over a span, as measured by the twin server. */
export interface OffsetRun extends TimeRange {
  readonly offsetSeconds: number;
}

/** A lookup loads this much measured history on either side of the instant. */
const LOAD_SPAN_MS = 30 * 60_000;
/** An instant between runs takes the offset of a run this close; farther away, the configured offset. */
const NEAREST_RUN_MS = 5_000;

export function parseOffsetRuns(body: unknown): OffsetRun[] {
  const runs = (body as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) throw new Error("Malformed archive offsets response");
  return runs
    .flatMap((item): OffsetRun[] => {
      const value = item as Record<string, unknown>;
      const startMs = typeof value.start === "string" ? Date.parse(value.start) : Number.NaN;
      const endMs = typeof value.end === "string" ? Date.parse(value.end) : Number.NaN;
      const offsetSeconds = value.offset_seconds;
      if (!Number.isFinite(startMs) || !(endMs > startMs) || typeof offsetSeconds !== "number" || !Number.isFinite(offsetSeconds)) return [];
      return [{ startMs, endMs, offsetSeconds }];
    })
    .sort((a, b) => a.startMs - b.startMs);
}

/** The measured offset at `ms`: the run covering it, else the nearest run within `NEAREST_RUN_MS`, else null. */
export function measuredOffsetAt(runs: readonly OffsetRun[], ms: number): number | null {
  let nearest: OffsetRun | null = null;
  let nearestDistance = NEAREST_RUN_MS;
  for (const run of runs) {
    if (run.startMs <= ms && ms < run.endMs) return run.offsetSeconds;
    const distance = ms < run.startMs ? run.startMs - ms : ms - run.endMs;
    if (distance <= nearestDistance) {
      nearest = run;
      nearestDistance = distance;
    }
  }
  return nearest?.offsetSeconds ?? null;
}

/**
 * How far one camera's recorded footage runs behind detection time, as the
 * twin server measured it per second; instants it did not measure use the
 * configured offset.
 */
export class ArchiveOffsets {
  private readonly loads: { span: TimeRange; runs: Promise<readonly OffsetRun[]> }[] = [];

  constructor(
    private readonly url: string | null,
    private readonly camera: string,
    private readonly configuredSeconds: number,
  ) {}

  /** Seconds the archive runs behind detection time at `ms`. */
  async at(ms: number): Promise<number> {
    if (!this.url) return this.configuredSeconds;
    const load = this.loads.findLast(({ span }) => span.startMs <= ms && ms <= span.endMs)
      ?? this.load(ms - LOAD_SPAN_MS, Math.min(Date.now(), ms + LOAD_SPAN_MS));
    return measuredOffsetAt(await load.runs, ms) ?? this.configuredSeconds;
  }

  /** Loads the offsets of `[startMs, endMs]` ahead of need. */
  prefetch(startMs: number, endMs: number): void {
    if (this.url) this.load(startMs, endMs);
  }

  private load(startMs: number, endMs: number): { span: TimeRange; runs: Promise<readonly OffsetRun[]> } {
    const url = new URL(this.url!, window.location.href);
    url.searchParams.set("camera", this.camera);
    url.searchParams.set("start", new Date(startMs).toISOString());
    url.searchParams.set("end", new Date(endMs).toISOString());
    const load = {
      span: { startMs, endMs },
      runs: fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseOffsetRuns(await response.json());
      }).catch(() => {
        // Unmeasured: the configured offset applies, and the next lookup here asks again.
        this.loads.splice(this.loads.indexOf(load), 1);
        return [];
      }),
    };
    this.loads.push(load);
    return load;
  }
}

/** A new camera loads its measured offsets for this long before now, the span the timelines show. */
const PREFETCH_MS = 60 * 60_000;
const shared = new Map<string, ArchiveOffsets>();

/** The offsets of `camera`, shared by every player showing it so a newly opened view does not wait for them. */
export function archiveOffsetsFor(url: string | null, camera: string, configuredSeconds: number): ArchiveOffsets {
  const key = `${url}\n${camera}\n${configuredSeconds}`;
  let offsets = shared.get(key);
  if (!offsets) {
    offsets = new ArchiveOffsets(url, camera, configuredSeconds);
    offsets.prefetch(Date.now() - PREFETCH_MS, Date.now());
    shared.set(key, offsets);
  }
  return offsets;
}
