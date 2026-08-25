/**
 * Traffic presets: the 5 v1 preset names map onto the migrated engine
 * ambient-traffic profiles (assets/traffic/*.ambient.json, copied verbatim
 * from engine apps/v2x-migration/traffic/). Placement uses the engine's
 * deterministic ambient materializer; the placed candidates are then spawned
 * into the live world as runtime actors with their authored routes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { materializeAmbientTrafficProfile, parseSimScenarioInput, type ActorKind, type SimScenarioInput } from '@simforge/engine';
import type { TwinConfig } from './config.js';
import type { TwinWorld } from './world.js';

export const TRAFFIC_PRESETS = ['none', 'light', 'medium', 'heavy', 'chaos'] as const;
export type TrafficPreset = (typeof TRAFFIC_PRESETS)[number];

export class TrafficController {
  private readonly world: TwinWorld;
  private readonly trafficDir: string;
  private readonly emptyBase: SimScenarioInput;

  constructor(world: TwinWorld, config: TwinConfig) {
    this.world = world;
    this.trafficDir = config.trafficDir;
    this.emptyBase = parseSimScenarioInput({
      mapId: config.mapId,
      dt: config.tickDt,
      warmupSeconds: 0,
      clipSeconds: 60,
      seed: 'twin-traffic',
      actors: [],
      interactions: [],
      operationalConditions: {},
    });
  }

  /** Replace current traffic with a preset population. Returns spawn count. */
  spawnPreset(preset: string): { preset: string; count: number } {
    this.despawnAll();
    const name: TrafficPreset = (TRAFFIC_PRESETS as readonly string[]).includes(preset) ? (preset as TrafficPreset) : 'medium';
    if (name === 'none') return { preset: name, count: 0 };

    const profileRaw = JSON.parse(readFileSync(path.join(this.trafficDir, `${name}.ambient.json`), 'utf8')) as Record<string, unknown>;
    // The materializer schema owns validation; strip the provenance note.
    delete profileRaw['_v2xCarlaSource'];
    const result = materializeAmbientTrafficProfile(this.emptyBase, this.world.bundle.graph, profileRaw);

    let count = 0;
    for (const actor of result.input.actors) {
      if (!actor.tags?.includes('ambient')) continue;
      const kind = actor.kind as ActorKind;
      const spawn = this.world.spawn({
        category: 'traffic',
        kind,
        blueprint: `traffic.${kind}`,
        spawn: {
          kind,
          pose: actor.initial.pose,
          speedMps: actor.initial.speedMps,
          snapToLane: true,
          ...(actor.behavior.route ? { route: actor.behavior.route } : {}),
          ...(actor.behavior.cruiseSpeedMps !== undefined ? { cruiseSpeedMps: actor.behavior.cruiseSpeedMps } : {}),
        },
      });
      if (spawn.ok) count += 1;
    }
    return { preset: name, count };
  }

  despawnAll(): number {
    let destroyed = 0;
    for (const { meta } of this.world.byCategory('traffic')) {
      if (this.world.despawn(meta.id)) destroyed += 1;
    }
    return destroyed;
  }
}
