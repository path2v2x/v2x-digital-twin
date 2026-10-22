/** The parked-car plan the panel summarises, and the cap applied to it. */

import type { ParkedCar } from "@/app/lib/studio-shared/parked-cars";

export interface ParkedCarPlan {
  readonly cars: readonly ParkedCar[];
  /** Stalls that could hold a car — the honest denominator for occupancy. */
  readonly eligibleStallCount: number;
  /** Stalls skipped because an exclusion covered them. */
  readonly excludedStallCount: number;
  /** Stalls skipped because no parkable model fits inside them. */
  readonly unfittableStallCount: number;
  /** What occupancy asked for, before {@link MAX_PARKED_CARS} cut it back. */
  readonly requestedCarCount: number;
}

/**
 * Ceiling on parked cars.
 *
 * The `.xosc` budget used to set this. It no longer does: marking a parked car
 * `static` makes the exporter emit it as a `ScenarioObject` with an Init
 * teleport and **no trajectory at all**, which took it from 234 KiB per car to
 * 1,940 B — measured, 121x. All 859 of Belmont's stalls would now be 1.81 MiB
 * against a 64 MiB plan ceiling, so roughly 34,000 cars would fit.
 *
 * What remains is simulation and CARLA spawn cost. A static actor skips motion
 * integration, routing, signals, and static/static collision pairs, but it still
 * occupies a slot in the actor array, the collision broadphase, and one trace
 * sample per fixed step — and a CARLA render has to spawn every one of them.
 * Neither cost is measured here, so this is a deliberate guard rather than a
 * measured ceiling: 250 covers a large lot several times over while keeping the
 * blast radius of "fill every stall on the map" bounded.
 *
 * Applied to the plan, not to baking, so the preview never shows cars an export
 * would drop.
 */
export const MAX_PARKED_CARS = 250;
