/** Motion deep-dive: why doesn't a spawned car move? */
import { loadMap } from '@simforge/compiler/node';
import { parseSimScenarioInput } from '@simforge/engine';
import { WorldSession } from '@simforge/training-env';

const bundle = await loadMap('richmond-field-station');
const input = parseSimScenarioInput({
  mapId: 'richmond-field-station',
  dt: 0.05,
  warmupSeconds: 0,
  clipSeconds: 60,
  seed: 'exp-motion',
  actors: [],
  interactions: [],
  operationalConditions: {},
});
const world = new WorldSession({ input, graph: bundle.graph, horizonSeconds: 3600 });

const spawn = world.applyCommand('c0', 1, {
  kind: 'spawn',
  spawn: { id: 'ego', kind: 'car', pose: { x: 0, z: 0 }, speedMps: 0, cruiseSpeedMps: 8 },
});
console.log('spawn:', JSON.stringify(spawn));

const snapAt = (label: string) => {
  const s = world.snapshot();
  const a = s.actors.find((x) => x.id === 'ego');
  console.log(label, a ? `x=${a.x.toFixed(2)} z=${a.z.toFixed(2)} v=${a.speedMps.toFixed(2)} hdg=${a.headingRad.toFixed(2)} present=${a.present} s=${a.s.toFixed(1)} lane=${a.laneRsl}` : 'MISSING');
};

snapAt('t=0 (pre-advance)');
for (let i = 0; i < 5; i++) {
  world.advance(20);
  snapAt(`after ${(i + 1)} s authored cruise`);
}

// Now control override
world.applyCommand('c0', 2, { kind: 'act', actorId: 'ego', action: { control: { throttle: 1, brake: 0, steer: 0 } } });
for (let i = 0; i < 3; i++) {
  world.advance(20);
  snapAt(`after ${(i + 1)} s throttle=1`);
}
