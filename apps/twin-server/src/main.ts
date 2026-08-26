/**
 * twin-server entrypoint: world + twin sync + publication + wire servers.
 * No CARLA anywhere; the world is a SimForge WorldSession on the
 * richmond-field-station bundle, ticked at 20 Hz.
 */
import { loadConfig } from './config.js';
import { Publisher } from './publication.js';
import { ScenarioStore } from './scenarios.js';
import { startServers } from './server.js';
import { TrafficController } from './traffic.js';
import { TrajectoryPlayer } from './trajectory.js';
import { TwinSync } from './twinsync.js';
import { TwinWorld } from './world.js';

const config = loadConfig();
console.log('='.repeat(60));
console.log('  V2X Digital Twin — SimForge twin-server');
console.log('='.repeat(60));
console.log(`  Map      : ${config.mapId} (${config.mapBundleDir})`);

const world = await TwinWorld.create(config);
console.log(`  Engine   : world session up, xodrSha256=${world.xodrSha256.slice(0, 12)}…, dt=${config.tickDt}s`);

const sync = new TwinSync(world, config);
const traffic = new TrafficController(world, config);
const trajectories = new TrajectoryPlayer(world, config);
const scenarios = new ScenarioStore(world, config);
const publisher = new Publisher(world, sync, config);

world.start();
sync.start();
publisher.start();
const servers = startServers({ world, config, sync, traffic, trajectories, scenarios });

console.log(`  Sync     : local=${config.syncLocal ? 'on' : 'off'} cloud=${config.syncCloud ? 'on' : 'off'} recorded=${config.recordedDetections}`);
console.log(`  Publish  : ${config.publishDir}${config.s3Bucket ? ` (S3 bucket configured: ${config.s3Bucket})` : ' (local only)'}`);
const spawnStats = world.spawnPointStats();
console.log(`  Spawn    : ${spawnStats.covered}/${spawnStats.total} road points inside streamed tile coverage (ego prefers covered)`);
console.log('  Ready. Waiting for connections…');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[twin-server] ${signal} — shutting down`);
  publisher.stop();
  sync.stop();
  world.stop();
  await servers.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
