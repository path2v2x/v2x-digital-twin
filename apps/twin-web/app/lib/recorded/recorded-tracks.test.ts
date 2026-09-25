import { buildLaneGraph, createFixedStepSimulation, parseSimScenarioInput, type FixedStepSimulationSession } from "@simforge-oss/engine";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/history-sample.json";
import {
  RECORDED_ACTOR_TAG,
  buildRecordedTracks,
  fetchWindowDetections,
  recordedScenarioParts,
  sceneFrameFromProj,
  type HistoryDetection,
  type RecordedTrack,
} from "./recorded-tracks";

const PROJ = "+proj=tmerc +lat_0=37.9150891287087 +lon_0=-122.333308830857 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs";
const FIXTURE_ITEMS = fixture.items as HistoryDetection[];
const FIXTURE_START_MS = Date.parse(fixture.start);
const FIXTURE_END_MS = Date.parse(fixture.end);
const T0 = Date.parse("2026-09-24T12:00:00.000Z");
// Synthetic detections carry scene metres directly in lat (z) / lon (x).
const identityScene = (lat: number, lon: number) => ({ x: lon, z: lat });

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function detection(tS: number, objectId: string, objectType: string, x: number, z: number, camera = "ch1"): HistoryDetection {
  return { ts: new Date(T0 + Math.round(tS * 1_000)).toISOString(), camera, object_id: objectId, object_type: objectType, confidence: 0.9, lat: z, lon: x };
}

function trackAt(track: RecordedTrack, t: number): { x: number; z: number } {
  const pts = track.points;
  const i = pts.findIndex((p) => p.t >= t);
  if (i <= 0) return pts[Math.max(0, i)]!;
  const a = pts[i - 1]!;
  const b = pts[i]!;
  const f = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

function fixtureTracks(): RecordedTrack[] {
  return buildRecordedTracks(FIXTURE_ITEMS, { windowStartMs: FIXTURE_START_MS, windowEndMs: FIXTURE_END_MS, toScene: sceneFrameFromProj(PROJ) });
}

function runScenario(tracks: readonly RecordedTrack[], clipSeconds: number): FixedStepSimulationSession {
  const parts = recordedScenarioParts(tracks, clipSeconds);
  const input = parseSimScenarioInput({
    mapId: "recorded-test",
    seed: 1,
    dt: 0.05,
    clipSeconds,
    warmupSeconds: 0,
    physics: { mode: "dynamic-v1" },
    actors: parts.actors,
    interactions: parts.interactions,
    signalPrograms: [],
    operationalConditions: {},
  });
  // Timed polylines need no lanes, so an empty graph is a valid map.
  return createFixedStepSimulation(input, { graph: buildLaneGraph({ lanes: {}, gates: [], junctions: {} }), guards: "collect" });
}

describe("fetchWindowDetections", () => {
  const row = (ts: string, objectId: string): HistoryDetection => ({ ts, camera: "ch2", object_id: objectId, object_type: "car", confidence: 0.8, lat: 37.9, lon: -122.3 });

  it("follows next cursors and drops rows repeated at the page boundary", async () => {
    const pages = [
      { items: [row("2026-09-24T23:00:00.000Z", "a"), row("2026-09-24T23:00:01.000Z", "a"), row("2026-09-24T23:00:02.000Z", "a")], next: "2026-09-24T23:00:02.000Z" },
      { items: [row("2026-09-24T23:00:02.000Z", "a"), row("2026-09-24T23:00:02.000Z", "b"), row("2026-09-24T23:00:03.000Z", "b")], next: null },
    ];
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
    }) as typeof fetch;

    const rows = await fetchWindowDetections("/detections/history", Date.parse("2026-09-24T23:00:00.000Z"), Date.parse("2026-09-24T23:01:00.000Z"), { fetcher });

    expect(rows.map((r) => `${r.ts.slice(17, 19)}:${r.object_id}`)).toEqual(["00:a", "01:a", "02:a", "02:b", "03:b"]);
    const queries = urls.map((u) => new URL(u, "http://twin.local"));
    expect(queries.map((q) => q.pathname)).toEqual(["/detections/history", "/detections/history"]);
    expect(queries.map((q) => q.searchParams.get("start"))).toEqual(["2026-09-24T23:00:00.000Z", "2026-09-24T23:00:02.000Z"]);
    expect(queries.every((q) => q.searchParams.get("end") === "2026-09-24T23:01:00.000Z" && q.searchParams.get("limit") === "5000")).toBe(true);
  });

  it("throws on a non-OK response and on a cursor that does not advance", async () => {
    const failing = (async () => new Response("down", { status: 503 })) as typeof fetch;
    await expect(fetchWindowDetections("/detections/history", 0, 60_000, { fetcher: failing })).rejects.toThrow("HTTP 503");
    const stuck = (async () => new Response(JSON.stringify({ items: [], next: "1970-01-01T00:00:00.000Z" }))) as typeof fetch;
    await expect(fetchWindowDetections("/detections/history", 0, 60_000, { fetcher: stuck })).rejects.toThrow("did not advance");
  });
});

describe("buildRecordedTracks", () => {
  it("smooths lateral zigzag jitter out of a straight 1.4 m/s walk", () => {
    const rand = mulberry32(7);
    const detections: HistoryDetection[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = i / 10;
      const lateral = (i % 2 === 0 ? 1 : -1) * (1 + 0.5 * rand());
      detections.push(detection(t, "walker", "person", 1.4 * t + (rand() * 2 - 1) * 0.3, lateral));
    }
    const tracks = buildRecordedTracks(detections, { windowStartMs: T0, windowEndMs: T0 + 20_000, toScene: identityScene });

    expect(tracks).toHaveLength(1);
    const { points, kind } = tracks[0]!;
    expect(kind).toBe("pedestrian");
    expect(points).toHaveLength(101);
    expect(points.every((p, i) => Math.abs(p.t - i / 5) < 1e-9)).toBe(true);
    expect(Math.max(...points.map((p) => Math.abs(p.z)))).toBeLessThan(0.4);
    expect(Math.max(...points.map((p) => Math.abs(p.x - 1.4 * p.t)))).toBeLessThan(0.4);
    const headings = points.slice(1).map((p, i) => Math.atan2(p.z - points[i]!.z, p.x - points[i]!.x));
    expect(Math.max(...headings.map(Math.abs))).toBeLessThan(0.3);
    expect(Math.max(...headings.slice(1).map((h, i) => Math.abs(h - headings[i]!)))).toBeLessThan(0.1);
  });

  it("merges cross-camera duplicates on the recorded fixture but keeps simultaneous same-camera tracks apart", () => {
    const tracks = fixtureTracks();
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const counts = new Map<string, { n: number; first: number; last: number }>();
    for (const d of FIXTURE_ITEMS) {
      const ms = Date.parse(d.ts);
      const c = counts.get(d.object_id) ?? { n: 0, first: ms, last: ms };
      counts.set(d.object_id, { n: c.n + 1, first: Math.min(c.first, ms), last: Math.max(c.last, ms) });
    }
    const eligible = [...counts.values()].filter((c) => c.n >= 5 && c.last - c.first >= 1_000).length;

    expect(eligible).toBe(21);
    expect(tracks).toHaveLength(18);
    for (const [kept, absorbed] of [["ch3_2647", "ch4_2667"], ["ch3_2652", "ch4_2679"], ["ch3_2658", "ch4_2675"]]) {
      expect(byId.get(`rec:person_cam-001-${kept}`)?.cameras).toEqual(["ch3", "ch4"]);
      expect(byId.has(`rec:person_cam-001-${absorbed}`)).toBe(false);
    }
    // ch2 saw these two at once ~0.75 m apart: two people, never one track.
    expect(byId.get("rec:person_cam-001-ch2_2640")?.cameras).toEqual(["ch2"]);
    expect(byId.get("rec:person_cam-001-ch2_2642")?.cameras).toEqual(["ch2"]);
    expect(tracks.every((t) => t.kind === "pedestrian" && t.objectType === "person")).toBe(true);

    const reversed = buildRecordedTracks([...FIXTURE_ITEMS].reverse(), { windowStartMs: FIXTURE_START_MS, windowEndMs: FIXTURE_END_MS, toScene: sceneFrameFromProj(PROJ) });
    expect(reversed).toEqual(tracks);
  });

  it("clips detections to the window and times points from the window start", () => {
    const windowStartMs = FIXTURE_START_MS + 5_000;
    const windowEndMs = FIXTURE_START_MS + 15_000;
    const tracks = buildRecordedTracks(FIXTURE_ITEMS, { windowStartMs, windowEndMs, toScene: sceneFrameFromProj(PROJ) });
    const ids = tracks.map((t) => t.id);

    expect(tracks.every((t) => t.points.every((p) => p.t >= 0 && p.t <= 10))).toBe(true);
    // Straddles the start: detections run 23:10:07.0–23:10:15.9, window starts 23:10:12.
    const straddling = tracks.find((t) => t.id === "rec:person_cam-001-ch2_2640")!;
    expect(straddling.points[0]!.t).toBeLessThanOrEqual(0.2);
    expect(straddling.points.at(-1)!.t).toBeCloseTo(3.8, 5);
    expect(ids).not.toContain("rec:person_cam-001-ch4_2709");
    expect(ids).not.toContain("rec:person_cam-001-ch2_2632");
  });

  it("maps object types to actor kinds and drops unknown or too-short objects", () => {
    const detections = [
      ...Array.from({ length: 11 }, (_, i) => detection(i / 10, "truck-1", "truck", 8 * (i / 10), 0)),
      ...Array.from({ length: 11 }, (_, i) => detection(i / 10, "dog-1", "dog", 0, 5)),
      ...Array.from({ length: 4 }, (_, i) => detection(i / 2, "car-short", "car", i, 10)),
      ...Array.from({ length: 8 }, (_, i) => detection(i / 10, "car-brief", "car", i, 20)),
    ];
    const tracks = buildRecordedTracks(detections, { windowStartMs: T0, windowEndMs: T0 + 10_000, toScene: identityScene });
    expect(tracks.map((t) => [t.id, t.kind])).toEqual([["rec:truck-1", "truck"]]);
  });
});

describe("recordedScenarioParts", () => {
  const walker = Array.from({ length: 51 }, (_, i) => detection(3 + i / 10, "ped-1", "person", 1.4 * (i / 10), 0, "ch2"));
  const car = Array.from({ length: 101 }, (_, i) => detection(i / 10, "car-1", "car", 8 * (i / 10), 30, "ch1"));
  const tracks = buildRecordedTracks([...walker, ...car], { windowStartMs: T0, windowEndMs: T0 + 10_000, toScene: identityScene });

  it("emits timed-polyline actors with presence interactions", () => {
    const { actors, interactions } = recordedScenarioParts(tracks, 10);
    const ped = actors.find((a) => a.id === "rec:ped-1")!;
    const vehicle = actors.find((a) => a.id === "rec:car-1")!;

    expect(ped).toMatchObject({ kind: "pedestrian", presentAtStart: false, tags: [RECORDED_ACTOR_TAG], behavior: { route: { kind: "timedPolyline" } } });
    expect(ped.initial.laneRef).toBeUndefined();
    expect(ped.initial.pose.headingRad).toBeCloseTo(0, 1);
    expect(ped.initial.speedMps).toBeCloseTo(1.4, 0);
    expect(vehicle).toMatchObject({ kind: "car", presentAtStart: true });
    expect(vehicle.dims).toBeUndefined();
    expect(interactions).toEqual([
      { id: "rec:ped-1:enter", actorId: "rec:ped-1", trigger: { kind: "at", t: 3 }, verb: "exist", target: { state: "present" } },
      { id: "rec:ped-1:exit", actorId: "rec:ped-1", trigger: { kind: "at", t: 8 }, verb: "exist", target: { state: "absent" } },
    ]);
  });

  it("replays recorded actors in the engine: absent before entry, on track while present, gone after exit", () => {
    const session = runScenario(tracks, 10);
    const pedTrack = tracks.find((t) => t.id === "rec:ped-1")!;
    const advanceTo = (t: number) => {
      while (session.peek().tS < t - 1e-9) session.advance(1);
      return session.peek();
    };

    expect(advanceTo(2).actors.find((a) => a.id === "rec:ped-1")?.present).toBe(false);
    expect(session.peek().actors.find((a) => a.id === "rec:car-1")?.present).toBe(true);
    const mid = advanceTo(5.5);
    const ped = mid.actors.find((a) => a.id === "rec:ped-1")!;
    const expected = trackAt(pedTrack, mid.tS);
    expect(ped.present).toBe(true);
    expect(ped.laneRsl).toBeNull();
    expect(Math.hypot(ped.x - expected.x, -ped.y - expected.z)).toBeLessThan(0.5);
    expect(advanceTo(9).actors.find((a) => a.id === "rec:ped-1")?.present).toBe(false);
  });

  it("replays the whole recorded fixture without recorded-vs-recorded crashes", () => {
    const tracks = fixtureTracks();
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const session = runScenario(tracks, 60);
    let maxError = 0;
    let samples = 0;
    while (!session.done) {
      session.advance(1);
      const snap = session.peek();
      for (const actor of snap.actors) {
        const track = byId.get(actor.id)!;
        const inside = snap.tS > track.points[0]!.t + 0.05 && snap.tS < track.points.at(-1)!.t - 0.05;
        if (!inside) continue;
        expect(actor.present).toBe(true);
        const expected = trackAt(track, snap.tS);
        maxError = Math.max(maxError, Math.hypot(actor.x - expected.x, -actor.y - expected.z));
        samples++;
      }
    }
    const events = session.drainEvents();
    expect(events.filter((e) => e.kind === "collision" || e.kind === "crash_disabled" || e.kind === "trigger_skipped")).toEqual([]);
    expect(samples).toBeGreaterThan(3_000);
    expect(maxError).toBeLessThan(0.5);
  });
});
