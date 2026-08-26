/** Placeable and operational catalog of the twin, mirroring the server's
 * documented wire vocabulary (docs/twin-protocol-v2.md). Ids are the exact
 * strings the server accepts; nothing here is decorative. */

export const WEATHER_PRESETS: Record<string, Record<string, number>> = {
  clear: { cloudiness: 10, precipitation: 0, fog_density: 0, sun_altitude_angle: 75 },
  overcast: { cloudiness: 85, precipitation: 0, fog_density: 0, sun_altitude_angle: 45 },
  rain: { cloudiness: 90, precipitation: 80, precipitation_deposits: 60, fog_density: 0, sun_altitude_angle: 35 },
  fog: { cloudiness: 60, precipitation: 0, fog_density: 40, fog_distance: 20, sun_altitude_angle: 25 },
};

/** spawn_traffic presets: the migrated engine ambient-traffic profiles. */
export const TRAFFIC_PRESETS = ['none', 'light', 'medium', 'heavy', 'chaos'] as const;

export interface CatalogEntry { id: string; name: string; detail: string }

/** load_scenario templates shipped in apps/twin-server/assets/scenarios. */
export const SCENARIOS: readonly CatalogEntry[] = [
  { id: 'firetruck-from-north.template.json', name: 'Firetruck from north', detail: 'EVA · template' },
  { id: 'firetruck-from-south.template.json', name: 'Firetruck from south', detail: 'EVA · template' },
  { id: 'sample-npc-cruise.template.json', name: 'NPC cruise', detail: 'ambient · template' },
];

/** spawn_object blueprints, verbatim from the server's vehicle_list reply. */
export const VEHICLES: readonly CatalogEntry[] = [
  { id: 'vehicle.tesla.model3', name: 'Tesla Model3', detail: 'car · 4 wheels' },
  { id: 'vehicle.lincoln.mkz', name: 'Lincoln MKZ', detail: 'car · 4 wheels' },
  { id: 'vehicle.dodge.charger', name: 'Dodge Charger', detail: 'car · 4 wheels' },
  { id: 'vehicle.nissan.patrol', name: 'Nissan Patrol', detail: 'car · 4 wheels' },
  { id: 'vehicle.mini.cooper', name: 'Mini Cooper', detail: 'car · 4 wheels' },
  { id: 'vehicle.carlamotors.firetruck', name: 'Firetruck', detail: 'truck · EVA tagged' },
  { id: 'vehicle.mercedes.sprinter', name: 'Mercedes Sprinter', detail: 'van · 4 wheels' },
  { id: 'vehicle.volkswagen.t2', name: 'Volkswagen T2', detail: 'van · 4 wheels' },
  { id: 'vehicle.kawasaki.ninja', name: 'Kawasaki Ninja', detail: 'motorcycle · 2 wheels' },
  { id: 'vehicle.bh.crossbike', name: 'BH Crossbike', detail: 'bicycle · 2 wheels' },
];

/** static.prop blueprints, verbatim from the server's object_list reply. */
export const PROPS: readonly CatalogEntry[] = [
  { id: 'static.prop.constructioncone', name: 'Construction cone', detail: 'prop' },
  { id: 'static.prop.trafficwarning', name: 'Traffic warning', detail: 'prop' },
  { id: 'static.prop.streetbarrier', name: 'Street barrier', detail: 'prop' },
  { id: 'static.prop.box', name: 'Box', detail: 'prop' },
];

/** start_trajectory recordings in apps/twin-server/assets/trajectories. */
export const TRAJECTORIES: readonly CatalogEntry[] = [
  { id: 'event1.json', name: 'Event 1', detail: 'recorded GPS track' },
];

export const TRAJECTORY_VEHICLE = 'vehicle.tesla.model3';
