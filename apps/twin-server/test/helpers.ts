import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_ROOT, REPO_ROOT, loadConfig, type TwinConfig } from '../src/config.js';
import { TwinWorld } from '../src/world.js';

/** Test config: unique ports + tmp publish dir, shipped assets. */
export function testConfig(overrides: Partial<TwinConfig> = {}): TwinConfig {
  const base = loadConfig();
  return {
    ...base,
    wsPort: 18765,
    httpPort: 18090,
    publishDir: mkdtempSync(path.join(tmpdir(), 'twin-pub-')),
    userScenariosDir: mkdtempSync(path.join(tmpdir(), 'twin-scen-')),
    userTrajectoriesDir: mkdtempSync(path.join(tmpdir(), 'twin-traj-')),
    camerasJson: path.join(REPO_ROOT, 'config', 'cameras.json'),
    recordedDetections: path.join(APP_ROOT, 'assets', 'recorded', 'event1.json'),
    ...overrides,
  };
}

export async function testWorld(config: TwinConfig = testConfig()): Promise<TwinWorld> {
  return TwinWorld.create(config);
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
