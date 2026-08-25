import { loadMap } from '@simforge/compiler/node';
import { parseSimScenarioInput } from '@simforge/engine';
import { WorldSession } from '@simforge/training-env';

const bundle = await loadMap('richmond-field-station');
const input = parseSimScenarioInput({
  mapId: 'richmond-field-station', dt: 0.05, warmupSeconds: 0, clipSeconds: 60,
  seed: 'expnan', actors: [], interactions: [], operationalConditions: {},
});

function freshWorld() {
  return new WorldSession({ input, graph: bundle.graph, horizonSeconds: 3600 });
}
const at = (w: WorldSession, label: string, id: string) => {
  const a = w.snapshot().actors.find((x) => x.id === id);
  console.log(label, a ? `x=${a.x.toFixed(2)} z=${a.z.toFixed(2)} v=${a.speedMps.toFixed(2)} hdg=${a.headingRad.toFixed(3)}` : 'MISSING');
};

// Case A: ghost alone
try {
  const w = freshWorld();
  w.applyCommand('c0', 1, { kind: 'spawn', spawn: {
    id: 'g1', kind: 'car', pose: { x: 30, z: 30, headingRad: 0 }, speedMps: 0, snapToLane: false,
    route: { kind: 'polyline', points: [{ x: 30, z: 30 }, { x: 10_030, z: 30 }] },
  }});
  w.applyCommand('c0', 2, { kind: 'act', actorId: 'g1', action: { previewPoint: { x: 40, z: 30 }, previewHeadingRad: 0, targetSpeedMps: 5 } });
  w.advance(40); at(w, 'A ghost 2s:', 'g1');
  w.applyCommand('c0', 3, { kind: 'act', actorId: 'g1', action: { previewPoint: { x: 40, z: 40 }, previewHeadingRad: Math.PI / 2, targetSpeedMps: 5 } });
  w.advance(40); at(w, 'A ghost turn 2s:', 'g1');
} catch (e) { console.log('A failed:', (e as Error).message); }

// Case B: ego brake-hold alone then more ticks
try {
  const w = freshWorld();
  w.applyCommand('c0', 1, { kind: 'spawn', spawn: {
    id: 'ego', kind: 'car', pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0, snapToLane: false,
    route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 10_000, z: 0 }] },
  }});
  w.applyCommand('c0', 2, { kind: 'act', actorId: 'ego', action: { control: { throttle: 0.7, brake: 0, steer: 0 } } });
  w.advance(40);
  w.applyCommand('c0', 3, { kind: 'act', actorId: 'ego', action: { control: { throttle: 0, brake: 1, steer: 0 } } });
  w.advance(40); at(w, 'B ego braked:', 'ego');
  w.advance(40); at(w, 'B ego +2s idle brake:', 'ego');
  w.applyCommand('c0', 4, { kind: 'spawn', spawn: { id: 'x1', kind: 'car', pose: { x: 50, z: 50, headingRad: 0 }, snapToLane: false, route: { kind: 'polyline', points: [{ x: 50, z: 50 }] } } });
  w.advance(20); at(w, 'B after 2nd spawn:', 'ego');
} catch (e) { console.log('B failed:', (e as Error).message); }
