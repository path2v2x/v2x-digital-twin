import { loadMap } from '@simforge/compiler/node';
import { parseSimScenarioInput } from '@simforge/engine';
import { WorldSession } from '@simforge/training-env';

const bundle = await loadMap('richmond-field-station');
const input = parseSimScenarioInput({
  mapId: 'richmond-field-station', dt: 0.05, warmupSeconds: 0, clipSeconds: 60,
  seed: 'exp3', actors: [], interactions: [], operationalConditions: {},
});
const world = new WorldSession({ input, graph: bundle.graph, horizonSeconds: 3600 });

// Ego: freeform long polyline route so it never retires; keyboard control via act.
const spawn = world.applyCommand('c0', 1, { kind: 'spawn', spawn: {
  id: 'ego', kind: 'car', pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0, snapToLane: false,
  route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 10_000, z: 0 }] },
}});
console.log('ego spawn:', JSON.stringify(spawn));
world.applyCommand('c0', 2, { kind: 'act', actorId: 'ego', action: { control: { throttle: 0.7, brake: 0, steer: 0 } } });
const at = (label: string, id: string) => {
  const a = world.snapshot().actors.find((x) => x.id === id);
  console.log(label, a ? `x=${a.x.toFixed(2)} z=${a.z.toFixed(2)} v=${a.speedMps.toFixed(2)} hdg=${a.headingRad.toFixed(3)}` : 'MISSING');
};
world.advance(40); at('ego 2s throttle .7:', 'ego');
world.applyCommand('c0', 3, { kind: 'act', actorId: 'ego', action: { control: { throttle: 0.5, brake: 0, steer: 0.3 } } });
world.advance(40); at('ego +2s steering right:', 'ego');
world.applyCommand('c0', 4, { kind: 'act', actorId: 'ego', action: { control: { throttle: 0, brake: 1, steer: 0 } } });
world.advance(40); at('ego +2s full brake:', 'ego');

// Ghost: freeform long polyline + preview act toward moving targets.
world.applyCommand('c0', 5, { kind: 'spawn', spawn: {
  id: 'g1', kind: 'car', pose: { x: 30, z: 30, headingRad: 0 }, speedMps: 0, snapToLane: false,
  route: { kind: 'polyline', points: [{ x: 30, z: 30 }, { x: 10_030, z: 30 }] },
}});
world.applyCommand('c0', 6, { kind: 'act', actorId: 'g1', action: { previewPoint: { x: 40, z: 30 }, previewHeadingRad: 0, targetSpeedMps: 5 } });
world.advance(20); at('ghost 1s toward (40,30):', 'g1');
world.advance(20); at('ghost 2s toward (40,30):', 'g1');
world.applyCommand('c0', 7, { kind: 'act', actorId: 'g1', action: { previewPoint: { x: 40, z: 40 }, previewHeadingRad: Math.PI / 2, targetSpeedMps: 5 } });
world.advance(40); at('ghost +2s toward (40,40):', 'g1');

// Timed-route trajectory actor: exact keyframes at absolute sim time.
const t0 = world.time();
world.applyCommand('c0', 8, { kind: 'spawn', spawn: {
  id: 'traj', kind: 'car', pose: { x: -20, z: -20, headingRad: 0 }, snapToLane: false,
  route: { kind: 'timedPolyline', points: [
    { timeS: t0, x: -20, z: -20 }, { timeS: t0 + 2, x: -10, z: -20 }, { timeS: t0 + 4, x: -10, z: -10 },
  ] },
}});
world.advance(40); at('traj at t0+2 (expect -10,-20):', 'traj');
world.advance(40); at('traj at t0+4 (expect -10,-10):', 'traj');
console.log('tick:', world.tick(), 'time:', world.time().toFixed(2));
