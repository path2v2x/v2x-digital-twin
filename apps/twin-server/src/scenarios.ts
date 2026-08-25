/**
 * Scenario placement: migrated engine templates (ScenarioPicker contract) and
 * user-saved object placements (save_scenario/load_scenario/delete_scenario).
 *
 * Migrated templates (assets/scenarios/*.template.json, copied verbatim from
 * engine apps/v2x-migration/scenarios/) are instantiated by spawning every
 * non-ego role at its authored pose with its authored lanePath route and
 * cruise speed. The template's `ego_vehicle` role is the drive session's ego
 * (externally controlled) and is not spawned. Interaction choreography
 * (`gap`/`speed` holds) is approximated by the engine's default
 * collision-avoiding follower — documented divergence.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ActorKind, RouteSpec } from '@simforge/engine';
import type { TwinConfig } from './config.js';
import type { TwinWorld } from './world.js';

interface TemplateRole {
  id: string;
  actor?: { class?: string; catalogId?: string; dims?: { length?: number; width?: number; height?: number } };
  label?: string;
  initialSpeedKph?: number;
  pose?: { position?: { x?: number; y?: number; z?: number }; headingRad?: number };
  initialRoute?: { mode?: string; lanes?: string[] };
}

interface ScenarioTemplate {
  meta?: { name?: string; description?: string };
  roles?: TemplateRole[];
}

export interface ScenarioListEntry {
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly kind: 'template' | 'placement';
}

/** User placement snapshot entry (v1 get_placed_snapshot shape). */
export interface PlacedObject {
  readonly blueprint: string;
  readonly pos: readonly [number, number, number];
  readonly yaw: number;
}

const KIND_BY_CLASS: Record<string, ActorKind> = {
  car: 'car',
  truck: 'truck',
  bus: 'bus',
  van: 'van',
  motorcycle: 'motorcycle',
  bicycle: 'bicycle',
  pedestrian: 'pedestrian',
};

export class ScenarioStore {
  private readonly world: TwinWorld;
  private readonly templatesDir: string;
  private readonly userDir: string;

  constructor(world: TwinWorld, config: TwinConfig) {
    this.world = world;
    this.templatesDir = config.scenariosDir;
    this.userDir = config.userScenariosDir;
  }

  list(): ScenarioListEntry[] {
    const out: ScenarioListEntry[] = [];
    if (existsSync(this.templatesDir)) {
      for (const file of readdirSync(this.templatesDir).sort()) {
        if (!file.endsWith('.template.json')) continue;
        try {
          const template = JSON.parse(readFileSync(path.join(this.templatesDir, file), 'utf8')) as ScenarioTemplate;
          out.push({
            file,
            name: template.meta?.name ?? file.replace('.template.json', ''),
            description: template.meta?.description ?? '',
            kind: 'template',
          });
        } catch {
          // unreadable template — skip
        }
      }
    }
    if (existsSync(this.userDir)) {
      for (const file of readdirSync(this.userDir).sort()) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(readFileSync(path.join(this.userDir, file), 'utf8')) as { name?: string };
          out.push({ file, name: data.name ?? file.replace('.json', ''), description: 'saved placement', kind: 'placement' });
        } catch {
          // skip
        }
      }
    }
    return out;
  }

  /**
   * Instantiate a migrated template into the live world. Returns spawned actor
   * ids (session-owned). The firetruck role keeps its EVA identity via the
   * vehicle.carlamotors.firetruck blueprint mapping.
   */
  instantiateTemplate(file: string, ownerSession: string): { spawned: string[]; failed: number; name: string; zones: unknown[] } {
    const template = JSON.parse(readFileSync(path.join(this.templatesDir, path.basename(file)), 'utf8')) as ScenarioTemplate;
    const spawned: string[] = [];
    let failed = 0;
    for (const role of template.roles ?? []) {
      if (role.id === 'ego_vehicle') continue; // externally controlled by the drive session
      const cls = role.actor?.class ?? 'car';
      const kind = KIND_BY_CLASS[cls] ?? 'car';
      const catalogId = role.actor?.catalogId ?? '';
      const blueprint = catalogId === 'vehicle.fire_engine' ? 'vehicle.carlamotors.firetruck' : `template.${cls}`;
      const position = role.pose?.position;
      if (!position || position.x === undefined || position.z === undefined) {
        failed += 1;
        continue;
      }
      const speedMps = (role.initialSpeedKph ?? 0) / 3.6;
      const dims = role.actor?.dims;
      const route: RouteSpec | undefined =
        role.initialRoute?.mode === 'lanePath' && role.initialRoute.lanes?.length
          ? { kind: 'lanePath', lanes: role.initialRoute.lanes }
          : undefined;
      const result = this.world.spawn({
        category: 'scenario',
        kind,
        blueprint,
        spawn: {
          kind,
          pose: { x: position.x, z: position.z, headingRad: role.pose?.headingRad ?? 0 },
          speedMps,
          snapToLane: route !== undefined,
          ...(route ? { route } : {}),
          ...(speedMps > 0 ? { cruiseSpeedMps: speedMps } : {}),
          ...(dims?.length && dims.width && dims.height ? { dims: { l: dims.length, w: dims.width, h: dims.height } } : {}),
        },
        meta: { name: role.label ?? role.id, ownerSession },
      });
      if (result.ok) spawned.push(result.id);
      else failed += 1;
    }
    return { spawned, failed, name: template.meta?.name ?? file, zones: [] };
  }

  isTemplate(file: string): boolean {
    return existsSync(path.join(this.templatesDir, path.basename(file)));
  }

  loadPlacement(file: string): { name: string; objects: PlacedObject[]; zones: unknown[] } {
    const data = JSON.parse(readFileSync(path.join(this.userDir, path.basename(file)), 'utf8')) as {
      name?: string;
      objects?: PlacedObject[];
      zones?: unknown[];
    };
    return { name: data.name ?? file, objects: data.objects ?? [], zones: data.zones ?? [] };
  }

  savePlacement(name: string, objects: readonly PlacedObject[], zones: readonly unknown[]): { file: string; object_count: number; zone_count: number } {
    const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '') || 'scenario';
    mkdirSync(this.userDir, { recursive: true });
    const file = `${slug}.json`;
    writeFileSync(path.join(this.userDir, file), JSON.stringify({ name, objects, zones }, null, 2));
    return { file, object_count: objects.length, zone_count: zones.length };
  }

  deletePlacement(file: string): void {
    const target = path.join(this.userDir, path.basename(file));
    if (!existsSync(target)) throw new Error(`Scenario not found: ${file}`);
    unlinkSync(target);
  }
}
