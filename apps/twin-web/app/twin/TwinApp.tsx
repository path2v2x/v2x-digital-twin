"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, LogIn, LogOut, RotateCcw } from "lucide-react";
import type { EditorController, EditorDocument, EditorState, ScenarioMapEntry } from "@simforge-oss/editor";
import { findRigFeature, resolveCameraPose } from "@simforge-oss/maps/camera-rig";
import type { CityViewer, CityViewerOptions } from "@simforge-oss/viewer";
import { CityView } from "@simforge-oss/viewer/react";
import { contentHash } from "@simforge-oss/engine";
import { toast } from "sonner";

import { TopBarActionsPortal, TopBarSlotProvider } from "@/app/components/TopBarSlot";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { AUTHORING_QUALITY, defaultAuthoringQuality } from "@/app/dashboard/scenario/editor/authoring-quality";
import { EditorConfigurationBlockProvider } from "@/app/dashboard/scenario/editor/inspector/EditorDetailsPanel";
import { EditorOverlayHost } from "@/app/dashboard/scenario/editor/inspector/EditorOverlayHost";
import { EditorOverlayProvider, useEditorOverlay } from "@/app/dashboard/scenario/editor/inspector/editor-overlay-selection";
import { ActorLibraryRail } from "@/app/dashboard/scenario/editor/regions/ActorLibraryRail";
import type { ViewportTool } from "@/app/dashboard/scenario/editor/regions/actor-catalog";
import { EditorHeader } from "@/app/dashboard/scenario/editor/regions/EditorHeader";
import { EditorModeBanner } from "@/app/dashboard/scenario/editor/regions/EditorModeBanner";
import { PlacementCursorHint } from "@/app/dashboard/scenario/editor/regions/PlacementCursorHint";
import { ScenarioTimelineDock } from "@/app/dashboard/scenario/editor/ScenarioTimelineDock";
import { timelineActorLabels, type V1TimelineBrowserPlayback } from "@/app/dashboard/scenario/editor/timeline/V1TimelineRail";
import { ScenarioEditorReadout, ScenarioEditorShell } from "@/app/dashboard/scenario/editor/shell";
import { EditorSceneEnvironmentBridge } from "@/app/dashboard/scenario/editor/EditorSceneEnvironmentBridge";
import { DocumentAmbientTrafficPanel } from "@/app/lib/scenario/ambient/AmbientTrafficPanel";
import { createAuthoredWorldSource, type AuthoredWorldSource, type RecordedLayer } from "@/app/lib/live-world/authored-world-source";
import { createTruthViewerBridge, type TruthViewerBridge } from "@/app/lib/live-world/truth-viewer-bridge";
import type { WorldSource } from "@/app/lib/live-world/types";
import { useWorldSource } from "@/app/lib/live-world/use-world-source";
import { buildRecordedTracks, fetchWindowDetections, recordedScenarioParts, sceneFrameFromProj } from "@/app/lib/recorded/recorded-tracks";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { useEditorRuntime } from "@/app/lib/scenario/editor/use-editor-runtime";
import type { ArchiveClock } from "./CameraFeed";
import { CameraStrip, type StripCamera } from "./CameraStrip";
import { CameraTimeline, type TimeSelection } from "./CameraTimeline";
import { CameraViewOverlay } from "./CameraViewOverlay";
import { actorSpeedKph, formatClipTime } from "./drive-telemetry";
import { usePoleCameras } from "./pole-cameras";
import { DETECTION_COVERAGE_URL, DETECTION_HISTORY_URL, useReplayConfig, type ReplayConfig } from "./replay-config";
import { TwinTopBar } from "./TwinTopBar";
import { useCameraLookThrough, type LookThroughTarget } from "./use-camera-look-through";

type FollowMode = "chase" | "dash";

/** Longest real-world window that can be simulated. */
const MAX_WINDOW_MS = 60_000;
const MIN_WINDOW_MS = 2_000;
/** Camera tiles follow the scrubbed playhead once it settles. */
const PLAYHEAD_SETTLE_MS = 300;

type Phase = { kind: "pick" } | { kind: "edit"; window: TimeSelection };

type RecordedState =
  | { status: "loading" }
  | { status: "ready"; layer: RecordedLayer; trackCount: number }
  | { status: "error"; message: string };

const CONTROLLED_KEY_CODES: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  KeyW: true,
  KeyA: true,
  KeyS: true,
  KeyD: true,
  KeyR: true,
  Space: true,
};

export function TwinApp() {
  const [map, setMap] = useState<ScenarioMapEntry | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const manifestUrl = params.get("manifest") ?? process.env.NEXT_PUBLIC_TWIN_MAP_MANIFEST_URL ?? null;
    const lanesUrl = params.get("lanes") ?? process.env.NEXT_PUBLIC_TWIN_MAP_LANES_URL ?? null;
    if (!manifestUrl) {
      setMapError("No map configured: set NEXT_PUBLIC_TWIN_MAP_MANIFEST_URL or pass ?manifest=");
      return;
    }
    try {
      setMap(directMapEntry({ manifestUrl, topologyUrl: lanesUrl, label: params.get("label") ?? "Richmond Field Station" }));
    } catch (error) {
      setMapError(errorMessage(error));
    }
  }, []);

  if (!map) {
    return (
      <div className="grid h-svh place-items-center bg-background text-sm text-muted-foreground" role={mapError ? "alert" : "status"}>
        {mapError ?? "Loading twin…"}
      </div>
    );
  }
  return (
    <TopBarSlotProvider>
      <TwinSurface map={map} />
    </TopBarSlotProvider>
  );
}

function TwinSurface({ map }: { map: ScenarioMapEntry }) {
  const replay = useReplayConfig();
  const nowMs = useNow(30_000);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [playheadMs, setPlayheadMs] = useState(initialPlayheadMs);
  const [selection, setSelection] = useState<TimeSelection | null>(null);
  const settledPlayheadMs = useSettled(playheadMs, PLAYHEAD_SETTLE_MS);
  const [recorded, setRecorded] = useState<RecordedState>({ status: "loading" });
  const [authoredSource, setAuthoredSource] = useState<AuthoredWorldSource | null>(null);
  const [authoredCreationError, setAuthoredCreationError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [bridge, setBridge] = useState<TruthViewerBridge | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("high");
  const [followMode, setFollowMode] = useState<FollowMode>("chase");
  const [egoActorId, setEgoActorId] = useState<string | null>(null);
  const [egoActorLabel, setEgoActorLabel] = useState<string | null>(null);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [enteringDrive, setEnteringDrive] = useState(false);
  const [expandedTool, setExpandedTool] = useState<ViewportTool | null>(null);
  const [transportRevision, setTransportRevision] = useState(0);
  const [documentRevision, setDocumentRevision] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const preparedDocumentHashRef = useRef<string | null>(null);
  const authored = useWorldSource(authoredSource);
  const transport = authoredSource?.transport ?? null;
  const poleCameras = usePoleCameras(map.browserManifestUrl);
  const editing = phase.kind === "edit";
  const window_ = phase.kind === "edit" ? phase.window : null;

  const onDocumentChange = useCallback((document: EditorDocument) => {
    const nextHash = contentHash(document.data);
    if (preparedDocumentHashRef.current === nextHash) return;
    preparedDocumentHashRef.current = nextHash;
    setDocumentRevision((revision) => revision + 1);
  }, []);

  useEffect(() => setQuality(defaultAuthoringQuality()), []);

  const runtime = useEditorRuntime({ record: null, map, viewer, runtimeReady: mapLoaded, hostRef, onDocumentChange });
  const { controller, editorDocument, state } = runtime;
  const selectedActor = state?.actors.find((actor) => state.selection.includes(actor.id)) ?? null;
  const selectedVehicleRole = selectedActor
    ? editorDocument?.data.roles.find((role) => role.id === selectedActor.id && isVehicleRole(role)) ?? null
    : null;
  const availableEgoActorId = authoredSource?.selectEgo(selectedVehicleRole?.id) ?? null;

  // The window's real-world actors: detection history → smoothed timed tracks.
  const windowStartMs = window_?.startMs ?? null;
  const windowEndMs = window_?.endMs ?? null;
  const georeference = replay.config?.georeference ?? null;
  useEffect(() => {
    if (windowStartMs === null || windowEndMs === null || !georeference) return;
    const controller = new AbortController();
    setRecorded({ status: "loading" });
    fetchWindowDetections(DETECTION_HISTORY_URL, windowStartMs, windowEndMs, { signal: controller.signal })
      .then((detections) => {
        const tracks = buildRecordedTracks(detections, { windowStartMs, windowEndMs, toScene: sceneFrameFromProj(georeference) });
        const parts = recordedScenarioParts(tracks, (windowEndMs - windowStartMs) / 1_000);
        setRecorded({ status: "ready", layer: parts, trackCount: tracks.length });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = errorMessage(error);
        setRecorded({ status: "error", message });
        toast.error("Recorded detections could not load", { description: message });
      });
    return () => controller.abort();
  }, [georeference, windowEndMs, windowStartMs]);

  // The scenario clip is the selected window, starting at its first instant.
  useEffect(() => {
    if (!editorDocument || windowStartMs === null || windowEndMs === null) return;
    const clipSeconds = (windowEndMs - windowStartMs) / 1_000;
    const choreography = editorDocument.data.choreography;
    if (choreography.clipSeconds !== clipSeconds || choreography.warmupSeconds !== 0) {
      editorDocument.setClip({ clipSeconds, warmupSeconds: 0 });
    }
  }, [editorDocument, windowEndMs, windowStartMs]);

  // The authored scenario plus the recorded layer, simulated in this browser.
  const recordedLayer = recorded.status === "ready" ? recorded.layer : null;
  useEffect(() => {
    if (!editorDocument || !recordedLayer || windowStartMs === null || windowEndMs === null) return;
    const clipSeconds = (windowEndMs - windowStartMs) / 1_000;
    if (editorDocument.data.choreography.clipSeconds !== clipSeconds) return;
    let disposed = false;
    let opened: AuthoredWorldSource | null = null;
    preparedDocumentHashRef.current = contentHash(editorDocument.data);
    setAuthoredCreationError(null);
    setAuthoredSource(null);
    void createAuthoredWorldSource({ document: editorDocument, map, tickHz: 20, recorded: recordedLayer, clipSeconds })
      .then((next) => {
        if (disposed) return next.close();
        opened = next;
        setAuthoredSource(next);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = errorMessage(error);
        setAuthoredCreationError(message);
        toast.error("Simulation could not start", { description: message });
      });
    return () => {
      disposed = true;
      setAuthoredSource(null);
      opened?.close();
    };
  }, [documentRevision, editorDocument, map, recordedLayer, windowEndMs, windowStartMs]);

  useEffect(() => {
    if (!authoredSource) return;
    setTransportRevision((revision) => revision + 1);
    return authoredSource.subscribeTransport(() => setTransportRevision((revision) => revision + 1));
  }, [authoredSource]);

  useEffect(() => {
    if (!authoredSource?.subscribeWarnings) return;
    return authoredSource.subscribeWarnings((message) => toast.warning("World notice", { description: message, duration: 12000 }));
  }, [authoredSource]);

  useEffect(() => {
    if (!bridge || !authoredSource) return;
    return authoredSource.subscribeFrames((frame) => bridge.apply(frame));
  }, [bridge, authoredSource]);
  useEffect(() => {
    if (!bridge) return;
    bridge.setFollow(driving && !transport?.completed ? egoActorId : null, followMode);
  }, [bridge, driving, egoActorId, followMode, transport, transportRevision]);
  useEffect(() => () => bridge?.dispose(), [bridge]);

  useDriveControls(authoredSource, driving ? egoActorId : null);

  const onViewerReady = useCallback((readyViewer: CityViewer) => {
    setViewer(readyViewer);
    setBridge(createTruthViewerBridge(readyViewer, { layer: "drive-live", groundLift: true }));
    setViewerError(null);
  }, []);

  const stripCameras = useMemo<StripCamera[]>(
    () =>
      poleCameras.rigs.flatMap((rig) => {
        const feature = findRigFeature(poleCameras.features, rig);
        return rig.cameras.map((camera) => ({
          key: `${rig.featureId}:${camera.id}`,
          camera,
          rigLabel: rig.label ?? `Pole ${rig.featureId}`,
          alignable: feature !== null,
        }));
      }),
    [poleCameras.features, poleCameras.rigs],
  );
  const timelineCameras = useMemo(
    () => stripCameras.map(({ camera }) => ({ id: camera.id, label: camera.id.toUpperCase() })),
    [stripCameras],
  );
  const lookTargets = useMemo(() => {
    const targets = new Map<string, LookThroughTarget>();
    for (const rig of poleCameras.rigs) {
      const feature = findRigFeature(poleCameras.features, rig);
      if (!feature) continue;
      for (const camera of rig.cameras) {
        targets.set(`${rig.featureId}:${camera.id}`, {
          pose: resolveCameraPose(feature, camera),
          sensorAspect: camera.intrinsics.width / camera.intrinsics.height,
        });
      }
    }
    return targets;
  }, [poleCameras.features, poleCameras.rigs]);
  const lookThrough = useCameraLookThrough(viewer, hostRef, lookTargets);
  const activeCamera = stripCameras.find((entry) => entry.key === lookThrough.activeKey) ?? null;
  const editorIdle = (state?.mode ?? "idle") === "idle";

  useEffect(() => {
    if (!lookThrough.activeKey || !editorIdle) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isEditableTarget(event.target)) return;
      lookThrough.release(true);
    };
    // The editor controller consumes Escape in a window capture listener; share its phase.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [editorIdle, lookThrough]);

  useEffect(() => {
    if (!driving || !authoredSource || !egoActorId) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => authoredSource.transport.play());
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [authoredSource, driving, egoActorId]);

  const selectActor = useCallback((actorId: string | null) => {
    setExpandedTool(null);
    controller?.setSelection(actorId ? [actorId] : []);
  }, [controller]);
  const selectLibraryTool = useCallback((tool: ViewportTool | null) => {
    setExpandedTool(tool);
    if (tool) controller?.setSelection([]);
  }, [controller]);

  const enterDrive = useCallback(() => {
    if (!authoredSource || !viewer || !editorDocument || enteringDrive) return;
    setEnteringDrive(true);
    try {
      const actorId = availableEgoActorId;
      if (!actorId) throw new Error("Place a vehicle before entering drive");
      lookThrough.release(false);
      authoredSource.setEgo(actorId);
      setEgoActorId(actorId);
      const roleId = authoredSource.roleIdForActor(actorId);
      const role = editorDocument.data.roles.find((candidate) => candidate.id === roleId)
        ?? (selectedVehicleRole && isVehicleRole(selectedVehicleRole) ? selectedVehicleRole : null)
        ?? editorDocument.data.roles.find(isVehicleRole)
        ?? null;
      const timelineLabel = role ? timelineActorLabels(editorDocument.data.roles).get(role.id) : null;
      setEgoActorLabel(timelineLabel ?? role?.label ?? actorId);
      bridge?.setFollow(actorId, followMode);
      setExpandedTool(null);
      setDriving(true);
    } catch (error) {
      toast.error("Drive mode could not start", { description: errorMessage(error) });
    } finally {
      setEnteringDrive(false);
    }
  }, [authoredSource, availableEgoActorId, bridge, editorDocument, enteringDrive, followMode, lookThrough, selectedVehicleRole, viewer]);

  const exitDrive = useCallback(() => {
    // Any of these can throw once the ego is released or the clip completed; UI state must still clear.
    try {
      bridge?.setFollow(null);
      if (authoredSource && egoActorId) authoredSource.control({ actorId: egoActorId, steer: 0, throttle: 0, brake: 0 });
      authoredSource?.setEgo(null);
    } catch (error) {
      toast.warning("Drive released with a warning", { description: errorMessage(error) });
    } finally {
      setDriving(false);
      setEgoActorId(null);
      setEgoActorLabel(null);
      setCameraNotice(null);
    }
  }, [authoredSource, bridge, egoActorId]);

  const pickedWindow = useMemo<TimeSelection | null>(() => {
    const candidate = selection ?? { startMs: playheadMs, endMs: Math.min(playheadMs + MAX_WINDOW_MS, nowMs) };
    const lengthMs = candidate.endMs - candidate.startMs;
    return lengthMs >= MIN_WINDOW_MS && lengthMs <= MAX_WINDOW_MS ? candidate : null;
  }, [nowMs, playheadMs, selection]);
  const simulateDisabledReason = !replay.config
    ? replay.error ?? "Loading recording configuration…"
    : !replay.config.historyAvailable
      ? "Detection history is unavailable on the server"
      : !pickedWindow
        ? `Select between ${MIN_WINDOW_MS / 1_000} and ${MAX_WINDOW_MS / 1_000} seconds`
        : null;

  const startSimulation = useCallback(() => {
    if (!pickedWindow || simulateDisabledReason) return;
    lookThrough.release(false);
    setPhase({ kind: "edit", window: { startMs: Math.round(pickedWindow.startMs), endMs: Math.round(pickedWindow.endMs) } });
  }, [lookThrough, pickedWindow, simulateDisabledReason]);

  const changeRange = useCallback(() => {
    if (driving) exitDrive();
    setExpandedTool(null);
    controller?.setSelection([]);
    if (window_) setPlayheadMs(window_.startMs);
    setAuthoredSource(null);
    setRecorded({ status: "loading" });
    setPhase({ kind: "pick" });
  }, [controller, driving, exitDrive, window_]);

  const driveSpeedKph = actorSpeedKph(authored.latestFrame, driving ? egoActorId : null);
  const driveClipTime = transport ? formatClipTime(transport.time, transport.duration) : null;
  useEffect(() => {
    if (!driving || !bridge || !egoActorId || !authored.latestFrame || transport?.completed) return;
    const present = authored.latestFrame.scene.actors.some((actor) => actor.id === egoActorId && actor.kind !== "despawn");
    if (present || cameraNotice) return;
    bridge.setFollow(null);
    setCameraNotice(`Driving view released because ${egoActorLabel ?? "the ego vehicle"} is unavailable.`);
  }, [authored.latestFrame, bridge, cameraNotice, driving, egoActorId, egoActorLabel, transport?.completed]);

  const timelinePlayback = useMemo<V1TimelineBrowserPlayback | null>(() => {
    if (!transport) return null;
    return {
      sessionId: transport.sessionId,
      playing: transport.playing,
      inspecting: transport.inspecting || transport.playing || driving,
      time: transport.time,
      onPlay: () => transport.play(),
      onStop: () => transport.stop(),
      onReset: () => transport.reset(),
      onPlayPause: () => transport.playPause(),
      onSeek: (seconds) => transport.seek(seconds),
      onExitInspection: () => transport.exitInspection(),
    };
    // transportRevision re-derives the playback snapshot when the transport mutates in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driving, transport, transportRevision]);

  // Cameras show the scrubbed instant while picking, and window start + simulation time while editing.
  const cameraClock = useMemo<ArchiveClock | null>(() => {
    if (!window_) return { timeMs: settledPlayheadMs, speed: 0 };
    if (!transport) return { timeMs: window_.startMs, speed: 0, prefetch: true };
    return { timeMs: window_.startMs + transport.time * 1_000, speed: transport.playing ? 1 : 0, prefetch: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPlayheadMs, transport, transportRevision, window_]);
  const archive = replay.config?.archive ?? null;

  const scenarioError = authoredCreationError ?? runtime.error ?? (authored.status === "error" ? authored.error : null);
  const driveUnavailableReason = authoredSource && !availableEgoActorId
    ? "Place a vehicle and wait for it to finish preparing before entering drive."
    : null;

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <TwinTopBar center={window_ ? <WindowReadout window={window_} recorded={recorded} onChangeRange={changeRange} /> : <PickReadout />} />
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <EditorConfigurationBlockProvider blocked={driving || !editing}>
            <EditorOverlayProvider
              documentKey={editorDocument}
              selectedActorId={selectedActor?.id ?? null}
              suppressActorDetails={driving || !editing || state?.mode === "drawingRoute"}
              onSelectActor={selectActor}
            >
              <EditorHeader document={editorDocument} quality={quality} onQualityChange={setQuality} viewer={viewer} experience="advanced" />
              {editing ? (
                <TopBarActionsPortal>
                  <div className="flex items-center gap-1">
                    {driving ? (
                      <>
                        <Button type="button" size="sm" variant="outline" onClick={() => setFollowMode((mode) => (mode === "chase" ? "dash" : "chase"))}>
                          <Camera /> {followMode === "chase" ? "Chase" : "Dash"}
                        </Button>
                        <Button type="button" size="sm" variant="secondary" onClick={exitDrive}>
                          <LogOut /> Exit drive
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        disabled={!authoredSource || !viewer || authored.status !== "running" || !availableEgoActorId || enteringDrive}
                        title={driveUnavailableReason ?? undefined}
                        onClick={enterDrive}
                      >
                        <LogIn /> {enteringDrive ? "Entering…" : "Enter drive"}
                      </Button>
                    )}
                  </div>
                </TopBarActionsPortal>
              ) : null}
              {/* The authored document owns weather and time of day. */}
              <EditorSceneEnvironmentBridge active={mapLoaded} document={editorDocument} quality={quality} viewer={viewer} />
              <ScenarioEditorShell
                className="h-full min-h-0 bg-background text-foreground"
                data-testid="twin-surface"
                data-phase={phase.kind}
                canvasMode="interactive"
                header={null}
                leftSidebar={!driving ? (slotProps) => (
                  <div
                    {...slotProps}
                    className={cn(slotProps.className, "flex h-full", !editing && "pointer-events-none select-none opacity-40")}
                    inert={!editing}
                    aria-disabled={!editing}
                    data-testid="actor-library"
                  >
                    <ActorLibraryRail
                      controller={controller}
                      state={state}
                      hostRef={hostRef}
                      canvas={viewer?.renderer.domElement ?? null}
                      activeTool={editing ? expandedTool : null}
                      onExpandedToolChange={selectLibraryTool}
                      document={editorDocument}
                      trafficDetails={editorDocument ? <DocumentAmbientTrafficPanel document={editorDocument} /> : null}
                    />
                  </div>
                ) : null}
                canvas={(slotProps) => (
                  <div {...slotProps} className={cn(slotProps.className, "relative bg-background")}>
                    <div ref={hostRef} className="absolute inset-0">
                      <CityView
                        key={quality}
                        manifestUrl={map.browserManifestUrl}
                        options={viewerOptions(quality)}
                        onReady={onViewerReady}
                        onMapLoaded={() => {
                          setMapLoaded(true);
                          setViewerError(null);
                        }}
                        onError={(reason) => {
                          const message = errorMessage(reason);
                          setMapLoaded(false);
                          setViewerError(message);
                          toast.error("Twin map could not load", { description: message });
                        }}
                        className="h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        ariaLabel={`${map.label} digital twin`}
                        role="application"
                        tabIndex={0}
                      />
                      {activeCamera && lookThrough.frame ? (
                        <CameraViewOverlay
                          frame={lookThrough.frame}
                          camera={activeCamera.camera}
                          rigLabel={activeCamera.rigLabel}
                          onExit={() => lookThrough.release(true)}
                          clock={cameraClock}
                          archive={archive}
                        />
                      ) : null}
                    </div>
                  </div>
                )}
                statusOverlay={(slotProps) => (
                  <div {...slotProps}>
                    {editing && state?.mode === "placing" ? (
                      <PlacementCursorHint state={state} hostRef={hostRef} canvas={viewer?.renderer.domElement ?? null} />
                    ) : editing && state?.mode && state.mode !== "idle" ? (
                      <div className="pointer-events-auto"><EditorModeBanner state={state} controller={controller} /></div>
                    ) : null}
                    {driving && driveClipTime ? (
                      <ScenarioEditorReadout
                        className="absolute left-4 top-4 flex items-baseline gap-3"
                        role="status"
                        aria-label={`Driving ${egoActorLabel ?? "vehicle"}, speed ${driveSpeedKph.toFixed(1)} kilometers per hour, clip time ${driveClipTime}${transport?.playing ? "" : ", paused"}`}
                      >
                        <span className="text-editor-text">{egoActorLabel ? `Driving ${egoActorLabel}` : "Driving"}</span>
                        <span className="text-editor-text tabular-nums">{driveSpeedKph.toFixed(1)} km/h</span>
                        <span className="tabular-nums">{driveClipTime}</span>
                        {!transport?.playing && !transport?.completed ? <span>Paused</span> : null}
                      </ScenarioEditorReadout>
                    ) : null}
                    {cameraNotice ? (
                      <ScenarioEditorReadout className="absolute left-4 top-14" role="status">
                        <span className="text-editor-text">{cameraNotice}</span>
                      </ScenarioEditorReadout>
                    ) : null}
                    {editing && transport?.completed ? (
                      <ScenarioEditorReadout className="pointer-events-auto absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3" role="status">
                        <span className="text-editor-text">Simulation complete · {formatClipTime(transport.time, transport.duration)}</span>
                        <Button type="button" size="sm" variant="secondary" onClick={() => transport.play()}>
                          <RotateCcw /> Replay
                        </Button>
                      </ScenarioEditorReadout>
                    ) : null}
                    <StatusNotices
                      viewerError={viewerError}
                      mapLoaded={mapLoaded}
                      replayError={replay.error}
                      recorded={editing ? recorded : null}
                      simulating={editing && recorded.status === "ready" && !authoredSource && !scenarioError}
                      scenarioError={editing ? scenarioError : null}
                    />
                  </div>
                )}
                floatingOverlay={editing ? (
                  editorDocument ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-auto max-h-[min(65vh,520px)] justify-center px-4" data-testid="floating-timeline-layer">
                      <div className="pointer-events-auto relative h-auto max-h-[min(65vh,520px)] w-full max-w-[920px] min-w-0">
                        <TwinTimelineDock controller={controller} document={editorDocument} state={state} playback={timelinePlayback} readOnly={driving} />
                      </div>
                    </div>
                  ) : null
                ) : (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-3">
                    <CameraTimeline
                      className="pointer-events-auto"
                      cameras={timelineCameras}
                      nowMs={nowMs}
                      earliestMs={nowMs - (replay.config?.retentionHours ?? 72) * 3_600_000}
                      coverageUrl={DETECTION_COVERAGE_URL}
                      archiveListUrlTemplate={archive?.listUrlTemplate ?? null}
                      archiveOffsetSeconds={archive?.offsetSeconds ?? 0}
                      playheadMs={playheadMs}
                      onPlayheadChange={setPlayheadMs}
                      selection={selection}
                      onSelectionChange={setSelection}
                      maxSelectionMs={MAX_WINDOW_MS}
                      onSimulate={startSimulation}
                      simulateDisabledReason={simulateDisabledReason}
                    />
                  </div>
                )}
              />
              {editing ? <EditorOverlayHost controller={controller} document={editorDocument} showActorMotionControls /> : null}
            </EditorOverlayProvider>
          </EditorConfigurationBlockProvider>
        </div>
        <CameraStrip
          cameras={stripCameras}
          activeKey={lookThrough.activeKey}
          onSelect={lookThrough.toggle}
          clock={cameraClock}
          archive={archive}
          error={poleCameras.error}
        />
      </div>
    </div>
  );
}

function PickReadout() {
  return (
    <span className="truncate text-xs text-muted-foreground" data-testid="phase-readout">
      Pick up to {MAX_WINDOW_MS / 1_000} s of recorded time to simulate
    </span>
  );
}

function WindowReadout({ window, recorded, onChangeRange }: { window: TimeSelection; recorded: RecordedState; onChangeRange: () => void }) {
  const seconds = Math.round((window.endMs - window.startMs) / 1_000);
  const day = new Date(window.startMs).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="phase-readout">
      <Button type="button" size="sm" variant="outline" onClick={onChangeRange} data-testid="change-range">
        <ArrowLeft /> Change range
      </Button>
      <span className="truncate text-xs tabular-nums text-foreground">
        {day} · {time(window.startMs)}–{time(window.endMs)} · {seconds} s
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {recorded.status === "ready"
          ? `${recorded.trackCount} recorded ${recorded.trackCount === 1 ? "actor" : "actors"}`
          : recorded.status === "loading"
            ? "Loading detections…"
            : "Detections unavailable"}
      </span>
    </div>
  );
}

function TwinTimelineDock({ controller, document, state, playback, readOnly }: {
  controller: EditorController | null;
  document: EditorDocument;
  state: EditorState | null;
  playback: V1TimelineBrowserPlayback | null;
  readOnly: boolean;
}) {
  const { selection, actions } = useEditorOverlay();
  return (
    <ScenarioTimelineDock
      document={document}
      state={state ?? undefined}
      playback={playback}
      selectedInteractionId={selection.kind === "interaction" ? selection.interactionId : null}
      onFocusActor={actions.selectActor}
      onSelectActor={actions.selectActor}
      onSelectInteraction={actions.selectInteraction}
      onClearSelection={actions.clear}
      readOnly={readOnly || controller === null}
      experience="advanced"
    />
  );
}

function StatusNotices({ viewerError, mapLoaded, replayError, recorded, simulating, scenarioError }: {
  viewerError: string | null;
  mapLoaded: boolean;
  replayError: string | null;
  recorded: RecordedState | null;
  simulating: boolean;
  scenarioError: string | null;
}) {
  const notices: Array<{ key: string; text: string; error: boolean }> = [];
  if (viewerError) notices.push({ key: "map", text: viewerError, error: true });
  else if (!mapLoaded) notices.push({ key: "map", text: "Loading map…", error: false });
  if (replayError) notices.push({ key: "replay", text: `Recordings: ${replayError}`, error: true });
  if (recorded?.status === "loading") notices.push({ key: "recorded", text: "Loading recorded detections…", error: false });
  else if (recorded?.status === "error") notices.push({ key: "recorded", text: `Detections: ${recorded.message}`, error: true });
  if (simulating) notices.push({ key: "sim", text: "Preparing simulation…", error: false });
  if (scenarioError) notices.push({ key: "scenario", text: `Scenario: ${scenarioError}`, error: true });
  if (notices.length === 0) return null;
  return (
    <div className="absolute left-1/2 top-4 flex -translate-x-1/2 flex-col items-center gap-1">
      {notices.map((notice) => (
        <div
          key={notice.key}
          role={notice.error ? "alert" : "status"}
          className={cn(
            "border bg-card/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur",
            notice.error ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground",
          )}
        >
          {notice.text}
        </div>
      ))}
    </div>
  );
}

/** `?at=<ISO time>` presets the playhead; otherwise five minutes ago. */
function initialPlayheadMs(): number {
  const fallback = Date.now() - 5 * 60_000;
  if (typeof window === "undefined") return fallback;
  const at = Date.parse(new URLSearchParams(window.location.search).get("at") ?? "");
  return Number.isFinite(at) && at <= Date.now() ? at : fallback;
}

/** Wall clock, refreshed every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** `value`, once it has stopped changing for `delayMs`. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return settled;
}

function directMapEntry({ manifestUrl, topologyUrl, label }: { manifestUrl: string; topologyUrl: string | null; label: string }): ScenarioMapEntry {
  const suffix = "/3d/manifest.json";
  if (!manifestUrl.endsWith(suffix)) throw new Error(`Map manifest must end in ${suffix}`);
  const root = manifestUrl.slice(0, -suffix.length);
  const id = `direct:${manifestUrl}`;
  const emptyDigest = "0".repeat(64);
  return {
    id,
    versionId: id,
    mapVersionId: id,
    sourceMapId: id,
    label,
    locality: "",
    browserAssetRootUrl: root,
    browserManifestUrl: manifestUrl,
    browserClosureSha256: emptyDigest,
    artifacts: {
      xodrSha256: emptyDigest,
      topologySha256: emptyDigest,
      derivedTopologySha256: emptyDigest,
      locationsSha256: emptyDigest,
      signalsSha256: emptyDigest,
      lanePolygonsSha256: emptyDigest,
    },
    sumoNetworkSha256: null,
    manifestUrl,
    topologyUrl: topologyUrl ?? `${root}/topology-index.json.gz`,
  };
}

type ScenarioRole = EditorDocument["data"]["roles"][number];
function isVehicleRole(role: ScenarioRole): boolean {
  return !role.actor.static && role.actor.class !== "pedestrian" && role.actor.class !== "static_object";
}

function viewerOptions(quality: ScenarioAuthoringQuality): CityViewerOptions {
  const preset = AUTHORING_QUALITY[quality];
  return { maxPixelRatio: preset.maxPixelRatio, antialias: preset.antialias, cinematicLighting: preset.cinematicLighting };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.isContentEditable || element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || element?.tagName === "SELECT");
}

function useDriveControls(source: WorldSource | null, actorId: string | null) {
  useEffect(() => {
    if (!source || !actorId) return;
    const pressed = new Set<string>();
    const keyDown = (event: KeyboardEvent) => {
      if (!CONTROLLED_KEY_CODES[event.code] || isEditableTarget(event.target)) return;
      event.preventDefault();
      pressed.add(event.code);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!CONTROLLED_KEY_CODES[event.code]) return;
      event.preventDefault();
      pressed.delete(event.code);
    };
    const transmit = () => {
      const steerLeft = pressed.has("KeyA") || pressed.has("ArrowLeft");
      const steerRight = pressed.has("KeyD") || pressed.has("ArrowRight");
      source.control({
        actorId,
        throttle: pressed.has("KeyW") || pressed.has("ArrowUp") ? 1 : 0,
        brake: pressed.has("Space") || pressed.has("KeyS") || pressed.has("ArrowDown") ? 1 : 0,
        steer: steerLeft === steerRight ? 0 : steerLeft ? -1 : 1,
        reverse: pressed.has("KeyR"),
      });
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    const interval = window.setInterval(transmit, 50);
    transmit();
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.clearInterval(interval);
    };
  }, [actorId, source]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
