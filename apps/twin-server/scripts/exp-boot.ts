/**
 * Boot experiment: WorldSession on the richmond-field-station bundle.
 * Validates: map load, base input, truth stream framing, runtime spawn,
 * control-act driving, preview-act ghost motion, rebuild cost.
 */
import { loadMap, buildMapControlPlan } from '@simforge/compiler/node';
import { parseSimScenarioInput } from '@simforge/engine';
import { WorldSession, TruthStreamClient } from '@simforge/training-env';

process.env.SCEN_DEV_ASSETS ??= '/home/path/simforge-assets/map-bundles';

const t0 = Date.now();
const bundle = await loadMap('richmond-field-station');
console.log('bundle loaded in', Date.now() - t0, 'ms; lanes graph ok:', !!bundle.graph);

const plan = buildMapControlPlan({
  index: bundle.index,
  graph: bundle.graph,
  topology: bundle.topology,
  signalCatalog: bundle.signalCatalog,
});
console.log('signal programs:', plan.signalPrograms.length);

const input = parseSimScenarioInput({
  mapId: 'richmond-field-station',
  dt: 0.05,
  warmupSeconds: 0,
  clipSeconds: 60,
  seed: 'v2x-twin-server',
  actors: [],
  interactions: [],
  signalPrograms: plan.signalPrograms,
  operationalConditions: {},
});
const t1 = Date.now();
const world = new WorldSession({ input, graph: bundle.graph, horizonSeconds: 4 * 3600 });
console.log('world session built in', Date.now() - t1, 'ms');

const sub = world.subscribeTruth({ capacity: 64 });
const client = new TruthStreamClient();
const frames: any[] = [];

function drain() {
  for (const bytes of sub.drain()) {
    for (const frame of client.push(bytes)) frames.push(frame);
  }
}

// empty world ticks
world.advance(3);
drain();
console.log('frames after 3 empty ticks:', frames.length, 'tick0:', frames[0]?.tick, 'actors:', frames[0]?.actors.length, 'signals:', frames[0]?.signals.length);

// spawn an ego near the camera pole (flat-earth origin area). Site pole is at
// lat 37.91560117034595 lon -122.33478756387032 → flat-earth ~ (–133.6, –56.9)?
// Just snap to nearest lane from scene (0,0).
let out = world.applyCommand('c0', 1, { kind: 'spawn', spawn: { id: 'ego', kind: 'car', pose: { x: 0, z: 0 }, speedMps: 0 } });
console.log('ego spawn:', JSON.stringify(out));
world.advance(1);
drain();

// throttle for 40 ticks (2 s)
out = world.applyCommand('c0', 2, { kind: 'act', actorId: 'ego', action: { control: { throttle: 0.8, brake: 0, steer: 0 } } });
console.log('act control:', JSON.stringify(out));
let t = Date.now();
world.advance(40);
console.log('40 ticks took', Date.now() - t, 'ms');
drain();
let last = frames[frames.length - 1];
let ego = last.scene.actors.find((a: any) => a.id === 'ego');
console.log('ego after 2s throttle: pos', ego.position, 'vel', ego.velocity, 'yaw', ego.yawRad);

// ghost: non-lane-snapped car, preview-act toward a target 10 m away
out = world.applyCommand('c0', 3, {
  kind: 'spawn',
  spawn: { id: 'ghost1', kind: 'car', pose: { x: 20, z: 20, headingRad: 0 }, snapToLane: false },
});
console.log('ghost spawn:', JSON.stringify(out));
world.advance(1);
drain();
last = frames[frames.length - 1];
let g = last.scene.actors.find((a: any) => a.id === 'ghost1');
console.log('ghost at spawn:', g.position);

out = world.applyCommand('c0', 4, {
  kind: 'act',
  actorId: 'ghost1',
  action: { previewPoint: { x: 30, z: 20 }, previewHeadingRad: 0, targetSpeedMps: 5 },
});
console.log('ghost act:', JSON.stringify(out));
world.advance(40);
drain();
last = frames[frames.length - 1];
g = last.scene.actors.find((a: any) => a.id === 'ghost1');
console.log('ghost after 2s preview-act:', g.position, 'vel', g.velocity);

// rebuild cost after ~85 ticks
t = Date.now();
out = world.applyCommand('c0', 5, { kind: 'spawn', spawn: { id: 'npc1', kind: 'car', pose: { x: -40, z: -100 } } });
console.log('structural rebuild at tick', world.tick(), 'took', Date.now() - t, 'ms; ok:', out.ok, out.error ?? '');

// tick throughput with 3 actors
t = Date.now();
world.advance(100);
console.log('100 ticks with 3 actors took', Date.now() - t, 'ms');
drain();
console.log('total frames:', frames.length, 'last tick:', frames[frames.length - 1].tick, 'timeSec:', frames[frames.length - 1].timeSec);
