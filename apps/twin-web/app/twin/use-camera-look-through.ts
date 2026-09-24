"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ResolvedCameraPose } from "@simforge-oss/maps/camera-rig";
import type { CameraView, CityViewer } from "@simforge-oss/viewer";

import { cameraViewForPose, viewDiverged, type CameraFrame } from "./camera-view";

export interface LookThroughTarget {
  readonly pose: ResolvedCameraPose;
  readonly sensorAspect: number;
}

export interface CameraLookThrough {
  readonly activeKey: string | null;
  readonly frame: CameraFrame | null;
  /** Look through `key`, or leave camera view when it is already active. */
  toggle(key: string): void;
  /** Leave camera view; `restore` returns to the free view held before entering. */
  release(restore: boolean): void;
}

/**
 * Blender-style camera view: the main viewer adopts a pole camera's pose and
 * field of view; navigating the viewer leaves camera view from wherever it is.
 */
export function useCameraLookThrough(
  viewer: CityViewer | null,
  hostRef: RefObject<HTMLElement | null>,
  targets: ReadonlyMap<string, LookThroughTarget>,
): CameraLookThrough {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [frame, setFrame] = useState<CameraFrame | null>(null);
  const freeViewRef = useRef<CameraView | null>(null);
  const appliedRef = useRef<CameraView | null>(null);

  const release = useCallback((restore: boolean) => {
    if (viewer) {
      if (restore && freeViewRef.current) viewer.controls.applyView(freeViewRef.current);
      viewer.setCameraPoseConstraintsEnabled(true);
    }
    freeViewRef.current = null;
    appliedRef.current = null;
    setActiveKey(null);
    setFrame(null);
  }, [viewer]);

  const toggle = useCallback((key: string) => {
    if (key === activeKey) release(true);
    else setActiveKey(key);
  }, [activeKey, release]);

  useEffect(() => {
    const target = activeKey ? targets.get(activeKey) : undefined;
    const host = hostRef.current;
    if (!viewer || !target || !host) return;
    freeViewRef.current ??= viewer.captureView();
    // Pole cameras sit outside the editor's navigation envelope.
    viewer.setCameraPoseConstraintsEnabled(false);

    const apply = () => {
      const next = cameraViewForPose(target.pose, host.clientWidth, host.clientHeight, target.sensorAspect);
      viewer.controls.applyView(next.view);
      appliedRef.current = viewer.captureView();
      setFrame(next.frame);
    };
    apply();
    const resize = new ResizeObserver(apply);
    resize.observe(host);

    let request = 0;
    const watch = () => {
      request = window.requestAnimationFrame(watch);
      const applied = appliedRef.current;
      if (applied && viewDiverged(applied, viewer.captureView())) release(false);
    };
    request = window.requestAnimationFrame(watch);
    return () => {
      resize.disconnect();
      window.cancelAnimationFrame(request);
    };
  }, [activeKey, hostRef, release, targets, viewer]);

  useEffect(() => {
    if (activeKey && !targets.has(activeKey)) release(false);
  }, [activeKey, release, targets]);

  return { activeKey, frame, toggle, release };
}
