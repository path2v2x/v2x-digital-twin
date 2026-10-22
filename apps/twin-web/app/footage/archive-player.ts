import { archiveOffsetsFor, type ArchiveOffsets } from "./archive-offsets";
import { avcCodecFromInit, DEFAULT_WINDOW_MS, footageUrl, windowAround, type ArchiveAccess } from "./archive";
import type { TimeRange } from "../twin/camera-timeline";

/** `loading`: the instant to show has not loaded yet, after a jump or because playback caught up with the loaded footage. */
export type FootageStatus = "loading" | "ready" | "no-recording" | "error";

/** Fetch the next window this long before playback reaches the end of loaded footage. */
const PREFETCH_MS = 8_000;
/** After a requested window has loaded, this much footage before it is fetched in the background so stepping back stays instant. */
const BACKFILL_MS = 10_000;
/** Footage kept in the browser; the windows farthest from the playhead are dropped beyond this. */
const MAX_BUFFERED_MS = 240_000;
/** Scrubbing into footage that is not loaded waits this long for the pointer to settle before requesting it. */
const LOAD_SETTLE_MS = 120;
/** The media timeline starts this far before now, so every archived instant maps to a positive media time. */
const ORIGIN_LOOKBACK_MS = 4 * 24 * 3_600_000;
/** A window that adds less footage than this means the archive has nothing further yet. */
const MIN_PROGRESS_S = 0.5;

interface Session {
  readonly channel: string;
  readonly access: ArchiveAccess;
  readonly media: MediaSource;
  readonly objectUrl: string;
  /** Media time 0 in detection-time milliseconds. */
  readonly originMs: number;
  /** Each window is fetched at the archive offset measured at its start and placed on the detection-time timeline. */
  readonly offsets: ArchiveOffsets;
  buffer: SourceBuffer | null;
}

interface Load {
  readonly session: Session;
  readonly span: TimeRange;
  readonly controller: AbortController;
  /** Fetched ahead of need (playback prefetch, backfill) rather than for a requested instant. */
  readonly background: boolean;
}

export interface PlaybackTick {
  /** Detection-time instant on screen, or null while a requested jump is still loading. */
  readonly ms: number | null;
  /** Playback reached the end of the recorded footage. */
  readonly ended: boolean;
}

function updateEnd(buffer: SourceBuffer): Promise<void> {
  if (!buffer.updating) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  buffer.addEventListener("updateend", () => resolve(), { once: true });
  return promise;
}

/** An early request stays registered this long; nobody having taken it over by then, it is cancelled. */
const EARLY_REQUEST_TTL_MS = 5_000;
/**
 * Footage requests started before a player asks (pointer resting on or pressing a detection), by URL.
 * A taken-over request stays listed until it expires, so asking again for the same window starts nothing.
 */
const earlyRequests = new Map<string, { response: Promise<Response>; controller: AbortController; taken: boolean }>();

/**
 * Starts requesting `span` of `channel` before a player asks for it, so the
 * round trip and the pre-roll from the preceding keyframe (up to ~1.4 MB) load
 * while the pointer rests on a detection. The player requesting the same
 * window takes over the response.
 */
export async function requestFootageEarly(access: ArchiveAccess, channel: string, span: TimeRange): Promise<void> {
  const offsetSeconds = await archiveOffsetsFor(access.offsetsUrl, channel, access.offsetSeconds).at(span.startMs);
  const url = footageUrl(access, channel, span, offsetSeconds);
  if (earlyRequests.has(url)) return;
  const controller = new AbortController();
  const request = { response: fetch(url, { signal: controller.signal }), controller, taken: false };
  request.response.catch(() => undefined);
  earlyRequests.set(url, request);
  window.setTimeout(() => {
    earlyRequests.delete(url);
    if (!request.taken) controller.abort();
  }, EARLY_REQUEST_TTL_MS);
}

/**
 * Plays archived footage of one camera through a single `<video>` element.
 * Each footage window is one MediaMTX fMP4 request streamed into a shared
 * MediaSource at its wall-clock position, so seeking inside loaded footage is
 * a `currentTime` change and loading new footage never blanks the picture.
 */
export class ArchivePlayer {
  private session: Session | null = null;
  private load: Load | null = null;
  private queue: Promise<void> = Promise.resolve();
  private targetMs: number | null = null;
  private wantPlay = false;
  private settleTimer: number | undefined;
  /** Detection-time instant past which the archive had nothing more to give. */
  private exhaustedAtMs: number | null = null;
  private status: FootageStatus = "loading";
  private statusDetail: string | undefined;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onStatus: (status: FootageStatus, detail?: string) => void,
  ) {
    video.muted = true;
    video.playsInline = true;
    // ManagedMediaSource (iOS Safari) only opens when remote playback is disabled.
    video.disableRemotePlayback = true;
    video.addEventListener("error", () => {
      this.setStatus("error", video.error?.message || "The footage could not be decoded");
    });
    // Playback that ran past the loaded footage waits for the next window; `canplay` also covers a pause while waiting.
    video.addEventListener("waiting", () => {
      if (this.status === "ready" && this.targetMs === null) this.setStatus("loading");
    });
    for (const resumed of ["canplay", "playing"]) {
      video.addEventListener(resumed, () => {
        if (this.status === "loading" && this.targetMs === null) this.setStatus("ready");
      });
    }
  }

  /** Switch camera (or archive); returns true when a new, empty footage timeline was opened. */
  setSource(channel: string, access: ArchiveAccess): boolean {
    const current = this.session;
    if (
      current
      && current.channel === channel
      && current.access.urlTemplate === access.urlTemplate
      && current.access.offsetsUrl === access.offsetsUrl
      && current.access.offsetSeconds === access.offsetSeconds
    ) return false;
    this.openSession(channel, access);
    return true;
  }

  /** Show detection-time `ms`, loading `span` (or a default window around it) if that footage is not loaded yet. */
  show(ms: number, span?: TimeRange): void {
    if (!this.session) return;
    if (this.session.media.readyState === "closed" && this.session.buffer) this.openSession(this.session.channel, this.session.access);
    this.targetMs = ms;
    this.exhaustedAtMs = null;
    window.clearTimeout(this.settleTimer);
    if (this.seekToTarget()) return;
    // Hold the current frame rather than play on from the old instant; playback resumes at the target once it loads.
    this.video.pause();
    this.setStatus("loading");
    const load = this.load;
    if (load && load.span.startMs <= ms && ms < load.span.endMs) return;
    const next = span ?? windowAround(ms);
    if (span) this.startLoad(next);
    else this.settleTimer = window.setTimeout(() => this.startLoad(next), LOAD_SETTLE_MS);
  }

  play(): void {
    this.wantPlay = true;
    if (this.targetMs === null) void this.video.play().catch(() => undefined);
  }

  pause(): void {
    this.wantPlay = false;
    this.video.pause();
  }

  /** Call once per animation frame while playing: reports the on-screen instant and keeps footage loaded ahead. */
  tick(): PlaybackTick {
    const session = this.session;
    if (!session || this.targetMs !== null) return { ms: null, ended: false };
    const ms = session.originMs + this.video.currentTime * 1_000;
    const endMs = this.locate(session, ms)?.endMs ?? null;
    if (endMs === null) return { ms, ended: false };
    if (this.exhaustedAtMs !== null && endMs <= this.exhaustedAtMs + 1) {
      const ended = endMs - ms < 100;
      if (ended) this.setStatus("no-recording");
      return { ms, ended };
    }
    if (!this.load && endMs - ms < PREFETCH_MS) {
      const startMs = Math.floor(endMs / 1_000) * 1_000;
      this.startLoad({ startMs, endMs: startMs + DEFAULT_WINDOW_MS }, true);
    }
    return { ms, ended: false };
  }

  dispose(): void {
    window.clearTimeout(this.settleTimer);
    this.load?.controller.abort();
    this.load = null;
    if (this.session) URL.revokeObjectURL(this.session.objectUrl);
    this.session = null;
    this.video.removeAttribute("src");
    this.video.load();
  }

  private openSession(channel: string, access: ArchiveAccess): void {
    this.load?.controller.abort();
    this.load = null;
    window.clearTimeout(this.settleTimer);
    if (this.session) URL.revokeObjectURL(this.session.objectUrl);
    const scope = globalThis as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource };
    const MediaSourceImpl = scope.MediaSource ?? scope.ManagedMediaSource;
    if (!MediaSourceImpl) {
      this.session = null;
      this.setStatus("error", "This browser cannot play archived footage");
      return;
    }
    const media = new MediaSourceImpl();
    const objectUrl = URL.createObjectURL(media);
    this.session = {
      channel,
      access,
      media,
      objectUrl,
      originMs: Math.floor((Date.now() - ORIGIN_LOOKBACK_MS) / 3_600_000) * 3_600_000,
      offsets: archiveOffsetsFor(access.offsetsUrl, channel, access.offsetSeconds),
      buffer: null,
    };
    this.exhaustedAtMs = null;
    this.video.src = objectUrl;
  }

  private setStatus(status: FootageStatus, detail?: string): void {
    if (status === this.status && detail === this.statusDetail) return;
    this.status = status;
    this.statusDetail = detail;
    this.onStatus(status, detail);
  }

  /**
   * Where loaded footage shows detection-time `ms`: the media time to seek to and the end of
   * that loaded range. A recording that starts up to half a second after `ms` counts, and is
   * shown from its first frame (MediaMTX stamps a window's first frame a little after its start).
   */
  private locate(session: Session, ms: number): { t: number; endMs: number } | null {
    const t = (ms - session.originMs) / 1_000;
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (t >= ranges.start(i) - 0.5 && t < ranges.end(i)) return { t: Math.max(t, ranges.start(i)), endMs: session.originMs + ranges.end(i) * 1_000 };
    }
    return null;
  }

  /** A window that ended before the pending target (a recording gap or relay restart) is requested again from the target's own second. */
  private retryFromTarget(span: TimeRange): void {
    const target = this.targetMs;
    if (target === null || this.seekToTarget()) return;
    const startMs = Math.floor(target / 1_000) * 1_000;
    if (span.startMs < startMs) this.startLoad({ startMs, endMs: startMs + DEFAULT_WINDOW_MS });
    else this.setStatus("no-recording");
  }

  /** Seek to the pending target once a frame for it is loaded. */
  private seekToTarget(): boolean {
    const session = this.session;
    const target = this.targetMs;
    if (!session || target === null) return false;
    const hit = this.locate(session, target);
    // Need at least one frame after the target, not just the range edge.
    if (!hit || hit.endMs - target < 50) return false;
    if (Math.abs(this.video.currentTime - hit.t) > 0.02) this.video.currentTime = hit.t;
    this.targetMs = null;
    this.setStatus("ready");
    if (this.wantPlay) void this.video.play().catch(() => undefined);
    return true;
  }

  private startLoad(span: TimeRange, background = false): void {
    const session = this.session;
    if (!session) return;
    this.load?.controller.abort();
    const load: Load = { session, span, controller: new AbortController(), background };
    this.load = load;
    this.queue = this.queue
      .then(() => this.stream(load))
      .catch((error: unknown) => {
        if (load.controller.signal.aborted || this.session !== session) return;
        this.setStatus("error", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (this.load === load) this.load = null;
      });
  }

  private async stream(load: Load): Promise<void> {
    const { session, span, controller } = load;
    const { signal } = controller;
    if (signal.aborted) return;
    const { media } = session;
    const offsetSeconds = session.offsets.at(span.startMs);
    if (media.readyState !== "open") {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      media.addEventListener("sourceopen", () => resolve(), { once: true });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      await promise;
    }
    const url = footageUrl(session.access, session.channel, span, await offsetSeconds);
    if (signal.aborted) return;
    const early = earlyRequests.get(url);
    const takeOver = early && !early.taken ? early : null;
    if (takeOver) {
      takeOver.taken = true;
      signal.addEventListener("abort", () => takeOver.controller.abort(), { once: true });
    }
    const response = await (takeOver?.response ?? fetch(url, { signal }));
    if (response.status === 404) {
      // MediaMTX answers 404 when the window starts where nothing was recorded.
      this.exhaustedAtMs = span.startMs;
      this.retryFromTarget(span);
      return;
    }
    if (!response.ok || !response.body) throw new Error(`Footage request failed (HTTP ${response.status})`);

    const loadedBefore = this.locate(session, span.startMs)?.endMs ?? null;
    const reader = response.body.getReader();
    // Bytes are held until the init segment names the codec; then the window is placed on the wall clock and appended.
    let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    let placed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        if (placed) {
          await this.append(session, value as Uint8Array<ArrayBuffer>, signal);
        } else {
          const joined = new Uint8Array(pending.length + value.length);
          joined.set(pending);
          joined.set(value, pending.length);
          pending = joined;
          if (!session.buffer) {
            const codec = avcCodecFromInit(pending);
            if (!codec) continue;
            session.buffer = media.addSourceBuffer(`video/mp4; codecs="${codec}"`);
            session.buffer.mode = "segments";
          }
          await updateEnd(session.buffer);
          // A previous window may have been cut mid-fragment: reset the parser before positioning this one.
          session.buffer.abort();
          session.buffer.timestampOffset = (span.startMs - session.originMs) / 1_000;
          // Frames past the span would overwrite (and break the decode chain of) footage loaded after it, e.g. by a backfill.
          session.buffer.appendWindowEnd = (span.endMs - session.originMs) / 1_000;
          placed = true;
          await this.append(session, pending, signal);
        }
        if (this.session === session) this.seekToTarget();
      }
    } finally {
      if (signal.aborted) void reader.cancel().catch(() => undefined);
    }
    if (signal.aborted || this.session !== session) return;
    const loadedAfter = this.locate(session, span.startMs)?.endMs ?? null;
    if (loadedAfter === null || (loadedBefore !== null && loadedAfter - loadedBefore < MIN_PROGRESS_S * 1_000)) {
      this.exhaustedAtMs = loadedAfter ?? span.startMs;
    }
    this.retryFromTarget(span);
    if (!load.background && this.load === load && this.locate(session, span.startMs - 1_000) === null) {
      this.startLoad({ startMs: span.startMs - BACKFILL_MS, endMs: span.startMs }, true);
    }
  }

  private async append(session: Session, chunk: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<void> {
    const buffer = session.buffer!;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted || session.media.readyState !== "open") return;
      try {
        buffer.appendBuffer(chunk);
        break;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "QuotaExceededError") || attempt > 0) throw error;
        await this.evict(session, 0);
      }
    }
    await updateEnd(buffer);
    await this.evict(session, MAX_BUFFERED_MS);
  }

  /** Drop the loaded footage farthest from the playhead until at most `budgetMs` remains (one range when the budget is 0). */
  private async evict(session: Session, budgetMs: number): Promise<void> {
    const buffer = session.buffer;
    if (!buffer || session.media.readyState !== "open") return;
    const ranges = this.video.buffered;
    let totalS = 0;
    const spans: Array<[number, number]> = [];
    for (let i = 0; i < ranges.length; i += 1) {
      spans.push([ranges.start(i), ranges.end(i)]);
      totalS += ranges.end(i) - ranges.start(i);
    }
    if (budgetMs > 0 && totalS * 1_000 <= budgetMs) return;
    const now = this.video.currentTime;
    const keepFrom = now - 30;
    const keepTo = now + 90;
    const distance = ([start, end]: [number, number]) => (end < now ? now - end : start > now ? start - now : 0);
    const far = spans.filter(([start, end]) => end < keepFrom || start > keepTo).sort((a, b) => distance(b) - distance(a))[0];
    const containing = spans.find(([start, end]) => start <= now && now < end);
    const [removeStart, removeEnd] = far
      ?? (containing && containing[0] < keepFrom ? [containing[0], keepFrom] : containing && containing[1] > keepTo ? [keepTo, containing[1]] : [0, 0]);
    if (removeEnd <= removeStart) return;
    await updateEnd(buffer);
    buffer.remove(removeStart, removeEnd);
    await updateEnd(buffer);
  }
}
