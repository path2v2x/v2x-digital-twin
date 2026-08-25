/** Captures one real framed truth_frame message to fixtures/truth-frame-sample.bin. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadMap, buildMapControlPlan } from '@simforge/compiler/node';
import { parseSimScenarioInput } from '@simforge/engine';
import { WorldSession, TruthStreamClient } from '@simforge/training-env';

const bundle = await loadMap('richmond-field-station');
const plan = buildMapControlPlan({ index: bundle.index, graph: bundle.graph, topology: bundle.topology, signalCatalog: bundle.signalCatalog });
const input = parseSimScenarioInput({
  mapId: 'richmond-field-station', dt: 0.05, warmupSeconds: 0, clipSeconds: 60,
  seed: 'v2x-twin-server', actors: [], interactions: [], signalPrograms: plan.signalPrograms, operationalConditions: {},
});
const world = new WorldSession({ input, graph: bundle.graph, horizonSeconds: 3600 });
world.advance(1);
world.applyCommand('c0', 1, { kind: 'spawn', spawn: { id: 'ego', kind: 'car', pose: { x: 0, z: 0 }, speedMps: 0 } });
const sub = world.subscribeTruth({ capacity: 8 });
world.advance(1);
const [bytes] = sub.drain();
if (!bytes) throw new Error('no frame');
const client = new TruthStreamClient();
const [frame] = client.push(bytes);
if (!frame) throw new Error('frame did not decode');
console.log('captured frame: tick', frame.tick, 'timeSec', frame.timeSec, 'actors', frame.actors.map((a) => `${a.id}:${a.class}`).join(','), 'signals', frame.signals.length, 'bytes', bytes.length);
mkdirSync('../../fixtures', { recursive: true });
writeFileSync('../../fixtures/truth-frame-sample.bin', bytes);
console.log('wrote fixtures/truth-frame-sample.bin');
