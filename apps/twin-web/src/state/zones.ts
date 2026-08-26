import { useCallback, useState } from 'react';
import { sceneToWgs84 } from '../lib/coordinates';
import type { Zone } from './twin';

/** Overlay-to-world mapping of the zone drawing capture: the drawing plane
 * spans 300 m around the junction anchor, verbatim from the v1 draw capture so
 * previously authored polygons keep landing in the same place. */
const ANCHOR_X = -130;
const ANCHOR_Z = -57;
const SPAN_M = 300;

/** A committed click, kept in overlay-normalised coordinates so the in-progress
 * polygon can be drawn back exactly where it was clicked. */
export interface Mark { u: number; v: number }

export interface ZoneTool {
  zones: readonly Zone[];
  drawing: boolean;
  vertices: readonly [number, number][];
  marks: readonly Mark[];
  start(): void;
  cancel(): void;
  addVertex(u: number, v: number): void;
  save(): void;
  remove(id: string): void;
}

/** V2X advisory zones: drawn on the canvas, persisted locally, synced to the
 * server as [lon,lat] polygons. */
export function useZones(send: (message: object) => void): ZoneTool {
  const [zones, setZones] = useState<Zone[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('v2x-zones') ?? '[]');
      return Array.isArray(stored) ? stored : [];
    } catch { return []; }
  });
  const [drawing, setDrawing] = useState(false);
  const [vertices, setVertices] = useState<[number, number][]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);

  const publish = useCallback((next: Zone[]) => {
    setZones(next);
    localStorage.setItem('v2x-zones', JSON.stringify(next));
    send({ type: 'sync_v2x_zones', zones: next });
  }, [send]);

  const start = useCallback(() => { setDrawing(true); setVertices([]); setMarks([]); }, []);
  const cancel = useCallback(() => { setDrawing(false); setVertices([]); setMarks([]); }, []);

  const addVertex = useCallback((u: number, v: number) => {
    const x = ANCHOR_X + (u - .5) * SPAN_M;
    const z = ANCHOR_Z + (v - .5) * SPAN_M;
    const point = sceneToWgs84([x, 0, z]);
    setVertices((current) => [...current, [point.lon, point.lat]]);
    setMarks((current) => [...current, { u, v }]);
  }, []);

  const save = useCallback(() => {
    if (vertices.length < 3) return;
    publish([...zones, {
      id: crypto.randomUUID(),
      name: `Zone ${zones.length + 1}`,
      message: 'Connected vehicle advisory',
      zone_kind: 'advisory',
      signal_type: 'v2x',
      polygon: vertices as [number, number][],
      color: '#E8E044',
    }]);
    setVertices([]);
    setMarks([]);
    setDrawing(false);
  }, [publish, vertices, zones]);

  const remove = useCallback((id: string) => publish(zones.filter((zone) => zone.id !== id)), [publish, zones]);

  return { zones, drawing, vertices, marks, start, cancel, addVertex, save, remove };
}
