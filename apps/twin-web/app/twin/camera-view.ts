import type { CameraView } from "@simforge-oss/viewer";
import type { ResolvedCameraPose } from "@simforge-oss/maps/camera-rig";

/** Visible sensor rectangle inside the viewport, in CSS pixels. */
export interface CameraFrame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const FRAME_MARGIN_PX = 16;

/** Largest rectangle with the sensor's aspect ratio that fits the viewport, centred. */
export function fitCameraFrame(viewportWidth: number, viewportHeight: number, sensorAspect: number): CameraFrame {
  const availableWidth = Math.max(1, viewportWidth - 2 * FRAME_MARGIN_PX);
  const availableHeight = Math.max(1, viewportHeight - 2 * FRAME_MARGIN_PX);
  const width = Math.min(availableWidth, availableHeight * sensorAspect);
  const height = width / sensorAspect;
  return {
    left: (viewportWidth - width) / 2,
    top: (viewportHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Vertical field of view for the whole viewport such that the centred frame
 * shows exactly the sensor's vertical field of view.
 */
export function viewportFovForFrame(sensorVerticalFovDeg: number, viewportHeight: number, frameHeight: number): number {
  const half = (sensorVerticalFovDeg * Math.PI) / 360;
  const scaled = Math.atan(Math.tan(half) * (viewportHeight / Math.max(1, frameHeight)));
  return (scaled * 360) / Math.PI;
}

/** The viewer view that looks through a resolved pole camera. */
export function cameraViewForPose(pose: ResolvedCameraPose, viewportWidth: number, viewportHeight: number, sensorAspect: number): { view: CameraView; frame: CameraFrame } {
  const frame = fitCameraFrame(viewportWidth, viewportHeight, sensorAspect);
  return {
    frame,
    view: {
      position: pose.position,
      target: pose.target,
      fov: viewportFovForFrame(pose.verticalFovDeg, viewportHeight, frame.height),
    },
  };
}

const POSITION_TOLERANCE_M = 0.01;
const FOV_TOLERANCE_DEG = 0.01;

/** True once the operator has navigated away from an applied camera view. */
export function viewDiverged(applied: CameraView, current: CameraView): boolean {
  const moved = (a: readonly number[], b: readonly number[]) =>
    Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) > POSITION_TOLERANCE_M;
  return (
    moved(applied.position, current.position) ||
    moved(applied.target, current.target) ||
    Math.abs(applied.fov - current.fov) > FOV_TOLERANCE_DEG
  );
}
