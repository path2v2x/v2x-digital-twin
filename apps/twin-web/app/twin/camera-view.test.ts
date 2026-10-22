import { describe, expect, it } from "vitest";

import { cameraViewForPose, fitCameraFrame, viewDiverged, viewportFovForFrame } from "./camera-view";

const SENSOR_ASPECT = 2560 / 1920;

describe("camera look-through", () => {
  it("fits a height-limited frame in a wide viewport and a width-limited frame in a tall one", () => {
    const wide = fitCameraFrame(1632, 832, SENSOR_ASPECT);
    expect(wide.height).toBeCloseTo(800);
    expect(wide.width).toBeCloseTo(800 * SENSOR_ASPECT);
    expect(wide.left + wide.width / 2).toBeCloseTo(816);

    const tall = fitCameraFrame(432, 1232, SENSOR_ASPECT);
    expect(tall.width).toBeCloseTo(400);
    expect(tall.height).toBeCloseTo(300);
    expect(tall.top + tall.height / 2).toBeCloseTo(616);
  });

  it("widens the viewport FOV so the frame spans exactly the sensor FOV", () => {
    expect(viewportFovForFrame(72, 800, 800)).toBeCloseTo(72);
    const fov = viewportFovForFrame(72, 1000, 500);
    const frameHalfTan = Math.tan((fov * Math.PI) / 360) * (500 / 1000);
    expect((Math.atan(frameHalfTan) * 360) / Math.PI).toBeCloseTo(72);
  });

  it("keeps the pose and reports divergence only after navigation", () => {
    const pose = { position: [1, 12, 3] as [number, number, number], target: [10, 0, 30] as [number, number, number], verticalFovDeg: 72, yawDeg: 0, pitchDeg: -30 };
    const { view } = cameraViewForPose(pose, 1632, 832, SENSOR_ASPECT);
    expect(view.position).toEqual([1, 12, 3]);
    expect(viewDiverged(view, { ...view })).toBe(false);
    expect(viewDiverged(view, { ...view, position: [1, 12.5, 3] })).toBe(true);
    expect(viewDiverged(view, { ...view, fov: view.fov + 1 })).toBe(true);
  });
});
