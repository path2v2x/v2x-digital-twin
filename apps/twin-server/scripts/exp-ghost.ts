import { loadMap } from '@simforge/compiler/node';
import { parseSimScenarioInput, localFromScene } from '@simforge/engine';
import { WorldSession } from '@simforge/training-env';

const bundle = await loadMap('richmond-field-station');
const input = parseSimScenarioInput({
  mapId: 'richmond-field-station', dt: 0.05, warmupSeconds: 0, clipSeconds: 60,
  seed: 'expg', actors: [], interactions: [], operationalConditions: {},
});
const w = new WorldSession({ input, graph: bundle.graph, horizonSeconds: 3600 });
const at = (label: string, id: string) => {
  const a = w.snapshot().actors.find((x) => x.id === id);
  console.log(label, a ? `x=${a.x.toFixed(2)} z=${a.z.toFixed(2)} v=${a.speedMps.toFixed(2)} hdg=${a.headingRad.toFixed(3)}` : 'MISSING');
};
w.advance(1); // move past t=0 before any act
w.applyCommand('c0', 1, { kind: 'spawn', spawn: {
  id: 'g1', kind: 'car', pose: { x: 30, z: 30, headingRad: 0 }, speedMps: 0, snapToLane: false,
  route: { kind: 'polyline', points: [{ x: 30, z: 30 }, { x: 10_030, z: 30 }] },
}});
const preview = (sx: number, sz: number, sp: number) => {
  const p = localFromScene({ x: sx, z: sz });
  const cur = w.snapshot().actors.find((x) => x.id === 'g1')!;
  const curLocal = localFromScene({ x: cur.x, z: cur.z });
  const hdg = Math.atan2(p.y - curLocal.y, p.x - curLocal.x);
  return { previewPoint: p, previewHeadingRad: hdg, targetSpeedMps: sp };
};
w.advance(1);
w.applyCommand('c0', 2, { kind: 'act', actorId: 'g1', action: preview(40, 30, 5) });
w.advance(20); at('ghost 1s toward (40,30):', 'g1');
w.advance(20); at('ghost 2s:', 'g1');
w.applyCommand('c0', 3, { kind: 'act', actorId: 'g1', action: preview(40, 40, 5) });
w.advance(20); at('ghost 1s toward (40,40):', 'g1');
w.advance(20); at('ghost 2s:', 'g1');
w.applyCommand('c0', 4, { kind: 'act', actorId: 'g1', action: { previewPoint: localFromScene({ x: 40, z: 40 }), previewHeadingRad: 0, targetSpeedMps: 0 } });
w.advance(20); at('ghost hold at target:', 'g1');
// expiry: despawn
const d = w.applyCommand('c0', 5, { kind: 'despawn', actorId: 'g1' });
console.log('despawn:', JSON.stringify(d));
w.advance(2);
at('after despawn:', 'g1');
console.log('present flags:', w.snapshot().actors.map((a) => `${a.id}:${a.present}`).join(' '));
