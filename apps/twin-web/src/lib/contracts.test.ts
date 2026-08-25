import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import golden from '../fixtures/v2x-richmond-golden-projections.json';
import { calibratedPose, CAMERAS, CAMERA_SITE } from './cameras';
import { legacyToWgs84, wgs84ToLegacy } from './coordinates';
import { decodeTruthFrame, encodeTruthFrame } from './truth';

describe('frozen V2X coordinate contract', () => {
  it(`matches all ${golden.points.length} engine golden points`, () => {
    expect(golden.points).toHaveLength(6);
    for (const point of golden.points) {
      const actual = wgs84ToLegacy(point.wgs84);
      // Golden coordinates are stored at 0.1 mm precision; 1 mm also covers the WGS values rounded to 9 decimals.
      expect(actual.x, `${point.id}.x`).toBeCloseTo(point.legacyFlatEarth[0], 3);
      expect(actual.y, `${point.id}.y`).toBeCloseTo(point.legacyFlatEarth[1], 3);
      const roundTrip = legacyToWgs84(actual);
      expect(roundTrip.lat, `${point.id}.lat`).toBeCloseTo(point.wgs84.lat, 12);
      expect(roundTrip.lon, `${point.id}.lon`).toBeCloseTo(point.wgs84.lon, 12);
    }
  });

  it('places every calibrated camera from the golden pole projection', () => {
    const poleFixture = golden.points.find((point) => point.id === 'camera-pole')!;
    const projectedPole = wgs84ToLegacy(CAMERA_SITE);
    expect(projectedPole.x).toBeCloseTo(poleFixture.legacyFlatEarth[0], 3);
    expect(projectedPole.y).toBeCloseTo(poleFixture.legacyFlatEarth[1], 3);
    for (const camera of CAMERAS) {
      const pose = calibratedPose(camera);
      const yaw = pose.yawDeg * Math.PI / 180;
      expect(pose.position[0] - camera.twin_pose.forward_offset_m * Math.cos(yaw)).toBeCloseTo(projectedPole.x, 10);
      expect(pose.position[2] - camera.twin_pose.forward_offset_m * Math.sin(yaw)).toBeCloseTo(projectedPole.y, 10);
      expect(pose.verticalFovDeg).toBeCloseTo(71.781, 3);
    }
  });
});

describe('truth_frame binary fixture', () => {
  it('decodes and byte-for-byte round-trips the committed captured frame', () => {
    const fixture = new Uint8Array(readFileSync(new URL('../../../../fixtures/truth-frame-sample.bin', import.meta.url)));
    const decoded = decodeTruthFrame(fixture);
    expect(decoded.scene.actors.length).toBe(decoded.actors.length);
    expect(decoded.tick).toBe(decoded.scene.tick);
    expect(encodeTruthFrame(decoded)).toEqual(fixture);
  });
});
