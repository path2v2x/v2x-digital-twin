import { loadMap } from '@simforge/compiler/node';
import { parseSimScenarioInput } from '@simforge/engine';
import { WorldSession } from '@simforge/training-env';

const bundle = await loadMap('richmond-field-station');
const input = parseSimScenarioInput({
  mapId: 'richmond-field-station', dt: 0.05, warmupSeconds: 0, clipSeconds: 60,
  seed: 'exp-motion', actors: [], interactions: [], operationalConditions: {},
});
const world = new WorldSession({ input, graph: bundle.graph, horizonSeconds: 3600 });
world.applyCommand('c0', 1, { kind: 'spawn', spawn: { id: 'ego', kind: 'car', pose: { x: 0, z: 0 }, speedMps: 0, cruiseSpeedMps: 8 } });
for (let i = 0; i < 8; i++) {
  const r = world.advance(20);
  const a = r.actors.find((x) => x.id === 'ego')!;
  const ev = r.events.map((e) => JSON.stringify(e)).join(' | ');
  console.log(`t=${r.tS.toFixed(1)} v=${a.speedMps.toFixed(2)} s=${a.s.toFixed(1)} ${ev}`);
}
