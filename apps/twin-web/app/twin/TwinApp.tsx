"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, LogIn, LogOut, RotateCcw } from "lucide-react";
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
import { useDriveAmbientTraffic } from "@/app/lib/scenario/ambient/useDriveAmbientTraffic";
import { createMultiplexedCameraFeeds, type CameraFeedState, type CameraFeeds } from "@/app/lib/live-world/camera-feeds";
import { createAuthoredWorldSource, type AuthoredWorldSource } from "@/app/lib/live-world/authored-world-source";
import { createRemoteWorldSource } from "@/app/lib/live-world/remote-world-source";
import { createTruthViewerBridge, type TruthViewerBridge } from "@/app/lib/live-world/truth-viewer-bridge";
import type { WorldClock, WorldReplayCapabilities, WorldSource, WorldSourceStatus } from "@/app/lib/live-world/types";
import { useWorldSource } from "@/app/lib/live-world/use-world-source";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { useEditorRuntime } from "@/app/lib/scenario/editor/use-editor-runtime";
import { CameraStrip, type StripCamera } from "./CameraStrip";
import { CameraViewOverlay } from "./CameraViewOverlay";
import { actorSpeedKph, formatClipTime } from "./drive-telemetry";
import { usePoleCameras } from "./pole-cameras";
import { TimeBar } from "./TimeBar";
import { TwinTopBar } from "./TwinTopBar";
import { useCameraLookThrough, type LookThroughTarget } from "./use-camera-look-through";

type FollowMode = "chase" | "dash";

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
  const twinUrl = useMemo(() => resolveTwinUrl(), []);
  const [twinSource, setTwinSource] = useState<WorldSource | null>(null);
  const [twinCreationError, setTwinCreationError] = useState<string | null>(null);
  const [authoredSource, setAuthoredSource] = useState<AuthoredWorldSource | null>(null);
  const [authoredCreationError, setAuthoredCreationError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [liveBridge, setLiveBridge] = useState<TruthViewerBridge | null>(null);
  const [authoredBridge, setAuthoredBridge] = useState<TruthViewerBridge | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("high");
  const [cameraFeeds, setCameraFeeds] = useState<CameraFeeds | null>(null);
  const [feedStates, setFeedStates] = useState<Readonly<Record<string, CameraFeedState>>>({});
  const [clock, setClock] = useState<WorldClock | null>(null);
  const [replay, setReplay] = useState<WorldReplayCapabilities | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
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
  const twin = useWorldSource(twinSource);
  const authored = useWorldSource(authoredSource);
  const transport = authoredSource?.transport ?? null;
  const poleCameras = usePoleCameras(map.browserManifestUrl);

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

  // The shared twin world: live detections, replay, and camera feeds.
  useEffect(() => {
    if (!twinUrl) {
      setTwinCreationError("No twin configured: set NEXT_PUBLIC_TWIN_URL or pass ?twin=");
      return;
    }
    const source = createRemoteWorldSource({ truthUrl: `${twinUrl}/twin`, commandUrl: `${twinUrl}/drive` });
    const feeds = createMultiplexedCameraFeeds({ url: `${twinUrl}/camera-feeds` });
    setTwinSource(source);
    setCameraFeeds(feeds);
    return () => {
      setTwinSource(null);
      setCameraFeeds(null);
      source.close();
      feeds.close();
    };
  }, [twinUrl]);

  // The authored scenario from the editor, simulated in this browser beside the twin.
  useEffect(() => {
    if (!editorDocument) return;
    let disposed = false;
    let opened: AuthoredWorldSource | null = null;
    preparedDocumentHashRef.current = contentHash(editorDocument.data);
    setAuthoredCreationError(null);
    setAuthoredSource(null);
    void createAuthoredWorldSource({ document: editorDocument, map, tickHz: 20 })
      .then((next) => {
        if (disposed) return next.close();
        opened = next;
        setAuthoredSource(next);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = errorMessage(error);
        setAuthoredCreationError(message);
        toast.error("Scenario could not start", { description: message });
      });
    return () => {
      disposed = true;
      setAuthoredSource(null);
      opened?.close();
    };
  }, [documentRevision, editorDocument, map]);

  useEffect(() => {
    if (!authoredSource) return;
    setTransportRevision((revision) => revision + 1);
    return authoredSource.subscribeTransport(() => setTransportRevision((revision) => revision + 1));
  }, [authoredSource]);

  useEffect(() => {
    const unsubscribers = [twinSource, authoredSource].flatMap((source) =>
      source?.subscribeWarnings
        ? [source.subscribeWarnings((message) => toast.warning("World notice", { description: message, duration: 12000 }))]
        : [],
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [authoredSource, twinSource]);

  useEffect(() => {
    if (!twinSource?.subscribeClock) {
      setClock(null);
      return;
    }
    return twinSource.subscribeClock(setClock);
  }, [twinSource]);

  useEffect(() => {
    if (!twinSource?.subscribeReplay) {
      setReplay(null);
      setReplayError(null);
      return;
    }
    return twinSource.subscribeReplay((capabilities, error) => {
      setReplay(capabilities);
      setReplayError(error);
    });
  }, [twinSource]);

  useEffect(() => {
    if (!cameraFeeds) {
      setFeedStates({});
      return;
    }
    setFeedStates(cameraFeeds.states);
    return cameraFeeds.subscribeStates(setFeedStates);
  }, [cameraFeeds]);

  const ambientTraffic = useDriveAmbientTraffic({
    document: editorDocument,
    map,
    viewer,
    mapLoaded,
    latestFrame: authored.latestFrame,
    mode: transport?.playing ? "playing" : transport?.inspecting ? "paused" : "authoring",
    time: transport?.time ?? 0,
    onFallback: (reason) => toast.error("SUMO unavailable", { description: reason }),
  });

  useEffect(() => {
    if (!liveBridge || !twinSource) return;
    return twinSource.subscribeFrames((frame) => liveBridge.apply(frame));
  }, [liveBridge, twinSource]);
  useEffect(() => {
    if (!authoredBridge || !authoredSource) return;
    return authoredSource.subscribeFrames((frame) => authoredBridge.apply(frame));
  }, [authoredBridge, authoredSource]);
  useEffect(() => {
    if (!authoredBridge) return;
    authoredBridge.setFollow(driving && !transport?.completed ? egoActorId : null, followMode);
  }, [authoredBridge, driving, egoActorId, followMode, transport, transportRevision]);
  useEffect(() => () => liveBridge?.dispose(), [liveBridge]);
  useEffect(() => () => authoredBridge?.dispose(), [authoredBridge]);

  useDriveControls(authoredSource, driving ? egoActorId : null);

  const onViewerReady = useCallback((readyViewer: CityViewer) => {
    setViewer(readyViewer);
    setLiveBridge(createTruthViewerBridge(readyViewer, { layer: "twin-live", groundLift: true }));
    setAuthoredBridge(createTruthViewerBridge(readyViewer, { layer: "drive-live", groundLift: true }));
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
      if (!actorId) throw new Error("Place an authored vehicle before entering drive");
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
      authoredBridge?.setFollow(actorId, followMode);
      setExpandedTool(null);
      setDriving(true);
    } catch (error) {
      toast.error("Drive mode could not start", { description: errorMessage(error) });
    } finally {
      setEnteringDrive(false);
    }
  }, [authoredBridge, authoredSource, availableEgoActorId, editorDocument, enteringDrive, followMode, lookThrough, selectedVehicleRole, viewer]);

  const exitDrive = useCallback(() => {
    // Any of these can throw once the ego is released or the clip completed; UI state must still clear.
    try {
      authoredBridge?.setFollow(null);
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
  }, [authoredBridge, authoredSource, egoActorId]);

  const driveSpeedKph = actorSpeedKph(authored.latestFrame, driving ? egoActorId : null);
  const driveClipTime = transport ? formatClipTime(transport.time, transport.duration) : null;
  useEffect(() => {
    if (!driving || !authoredBridge || !egoActorId || !authored.latestFrame || transport?.completed) return;
    const present = authored.latestFrame.scene.actors.some((actor) => actor.id === egoActorId && actor.kind !== "despawn");
    if (present || cameraNotice) return;
    authoredBridge.setFollow(null);
    setCameraNotice(`Driving view released because ${egoActorLabel ?? "the ego vehicle"} is unavailable.`);
  }, [authored.latestFrame, authoredBridge, cameraNotice, driving, egoActorId, egoActorLabel, transport?.completed]);

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

  const twinStatus: WorldSourceStatus = twinCreationError ? "error" : twin.status;
  const twinError = twinCreationError ?? twin.error;
  const authoredError = authoredCreationError ?? runtime.error ?? (authored.status === "error" ? authored.error : null);
  const driveUnavailableReason = authoredSource && !availableEgoActorId
    ? "Place an authored vehicle and wait for it to finish preparing before entering drive."
    : null;

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <TwinTopBar timeBar={<TimeBar source={twinSource} capabilities={replay} clock={clock} replayError={replayError} />} />
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <EditorConfigurationBlockProvider blocked={driving}>
            <EditorOverlayProvider
              documentKey={editorDocument}
              selectedActorId={selectedActor?.id ?? null}
              suppressActorDetails={driving || state?.mode === "drawingRoute"}
              onSelectActor={selectActor}
            >
              <EditorHeader document={editorDocument} quality={quality} onQualityChange={setQuality} viewer={viewer} experience="advanced" />
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
              {/* The authored document owns weather and time of day. */}
              <EditorSceneEnvironmentBridge active={mapLoaded} document={editorDocument} quality={quality} viewer={viewer} />
              <ScenarioEditorShell
                className="h-full min-h-0 bg-background text-foreground"
                data-testid="twin-surface"
                canvasMode="interactive"
                header={null}
                leftSidebar={!driving ? (slotProps) => (
                  <div {...slotProps} className={cn(slotProps.className, "flex h-full")}>
                    <ActorLibraryRail
                      controller={controller}
                      state={state}
                      hostRef={hostRef}
                      canvas={viewer?.renderer.domElement ?? null}
                      activeTool={expandedTool}
                      onExpandedToolChange={selectLibraryTool}
                      document={editorDocument}
                      trafficDetails={ambientTraffic.trafficDetails}
                      sumoAvailable={ambientTraffic.sumoAvailable}
                      sumoStatus={ambientTraffic.sumoStatus}
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
                          feeds={cameraFeeds}
                          feedState={feedStates[activeCamera.camera.id] ?? "starting"}
                          clock={clock}
                          archiveUrlTemplate={replay?.archiveUrlTemplate ?? null}
                          archiveOffsetSeconds={replay?.archiveOffsetSeconds ?? 0}
                        />
                      ) : null}
                    </div>
                  </div>
                )}
                statusOverlay={(slotProps) => (
                  <div {...slotProps}>
                    {state?.mode === "placing" ? (
                      <PlacementCursorHint state={state} hostRef={hostRef} canvas={viewer?.renderer.domElement ?? null} />
                    ) : state?.mode && state.mode !== "idle" ? (
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
                    {transport?.completed ? (
                      <ScenarioEditorReadout className="pointer-events-auto absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3" role="status">
                        <span className="text-editor-text">Scenario complete · {formatClipTime(transport.time, transport.duration)} · Free camera restored</span>
                        <Button type="button" size="sm" variant="secondary" onClick={() => transport.play()}>
                          <RotateCcw /> Replay
                        </Button>
                      </ScenarioEditorReadout>
                    ) : null}
                    <WorldStatusNotices twinStatus={twinStatus} twinError={twinError} authoredError={authoredError} viewerError={viewerError} mapLoaded={mapLoaded} />
                  </div>
                )}
                floatingOverlay={editorDocument ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-auto max-h-[min(65vh,520px)] justify-center px-4" data-testid="floating-timeline-layer">
                    <div className="pointer-events-auto relative h-auto max-h-[min(65vh,520px)] w-full max-w-[920px] min-w-0">
                      <TwinTimelineDock controller={controller} document={editorDocument} state={state} playback={timelinePlayback} readOnly={driving} />
                    </div>
                  </div>
                ) : null}
              />
              <EditorOverlayHost controller={controller} document={editorDocument} showActorMotionControls />
            </EditorOverlayProvider>
          </EditorConfigurationBlockProvider>
        </div>
        <CameraStrip
          cameras={stripCameras}
          activeKey={lookThrough.activeKey}
          onSelect={lookThrough.toggle}
          feeds={cameraFeeds}
          clock={clock}
          archiveUrlTemplate={replay?.archiveUrlTemplate ?? null}
          archiveOffsetSeconds={replay?.archiveOffsetSeconds ?? 0}
          error={poleCameras.error}
        />
      </div>
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

function WorldStatusNotices({ twinStatus, twinError, authoredError, viewerError, mapLoaded }: {
  twinStatus: WorldSourceStatus;
  twinError: string | null;
  authoredError: string | null;
  viewerError: string | null;
  mapLoaded: boolean;
}) {
  const notices: Array<{ key: string; text: string; error: boolean }> = [];
  if (viewerError) notices.push({ key: "map", text: viewerError, error: true });
  else if (!mapLoaded) notices.push({ key: "map", text: "Loading map…", error: false });
  if (twinError || twinStatus === "error") notices.push({ key: "twin", text: `Twin: ${twinError ?? "connection failed"}`, error: true });
  else if (twinStatus === "connecting" || twinStatus === "idle") notices.push({ key: "twin", text: "Connecting to the twin…", error: false });
  else if (twinStatus === "closed") notices.push({ key: "twin", text: "Twin connection closed", error: true });
  if (authoredError) notices.push({ key: "scenario", text: `Scenario: ${authoredError}`, error: true });
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

function resolveTwinUrl(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("twin") ?? process.env.NEXT_PUBLIC_TWIN_URL ?? null;
  if (!raw) return null;
  if (/^wss?:\/\//.test(raw)) return raw.replace(/\/+$/, "");
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.hostname}:${raw}`;
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
