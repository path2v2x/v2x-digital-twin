import { describe, expect, it } from 'vitest';

import { preparePreviewTracks, recordedPreviewFrame } from './recorded-preview';
import type { RecordedTrack } from './recorded-tracks';

const walker: RecordedTrack = {
  id: 'ped-1',
  objectType: 'person',
  kind: 'pedestrian',
  cameras: ['ch3'],
  // Walks toward scene -z for 4 s, then stands still.
  points: [
    { t: 2, x: 0, z: 0 },
    { t: 4, x: 0, z: -2 },
    { t: 6, x: 0, z: -4 },
    { t: 8, x: 0, z: -4 },
  ],
};

describe('recordedPreviewFrame', () => {
  const tracks = preparePreviewTracks([walker]);

  it('is absent outside its recorded span', () => {
    expect(recordedPreviewFrame(tracks, 1.9, 1).scene.actors).toEqual([]);
    expect(recordedPreviewFrame(tracks, 8.1, 2).actors).toEqual([]);
  });

  it('interpolates position and faces its motion in the engine heading convention', () => {
    const frame = recordedPreviewFrame(tracks, 3, 3);
    const [actor] = frame.scene.actors;
    expect(actor?.position).toEqual([0, 0, -1]);
    // Scene forward is (cos h, -sin h): moving toward -z is h = +π/2.
    expect(actor?.yawRad).toBeCloseTo(Math.PI / 2);
    expect(frame.actors[0]).toMatchObject({ id: 'ped-1', class: 'pedestrian', dims: { l: 0.3, w: 0.3, h: 1.75 } });
  });

  it('keeps the last heading while standing still', () => {
    expect(recordedPreviewFrame(tracks, 7.5, 4).scene.actors[0]?.yawRad).toBeCloseTo(Math.PI / 2);
  });
});
