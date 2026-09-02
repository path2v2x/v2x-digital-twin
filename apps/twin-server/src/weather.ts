/**
 * Weather compatibility fields map onto the engine's authored environment.
 * Keys without an engine counterpart are clamped and echoed without changing
 * scene state.
 */

export const DEFAULT_DRIVE_WEATHER: Record<string, number> = {
  cloudiness: 0.0,
  precipitation: 0.0,
  precipitation_deposits: 0.0,
  wind_intensity: 30.0,
  sun_azimuth_angle: 180.0,
  sun_altitude_angle: 75.0,
  fog_density: 0.0,
  fog_distance: 100000.0,
  fog_falloff: 0.1,
  wetness: 0.0,
  scattering_intensity: 1.0,
  mie_scattering_scale: 0.03,
  rayleigh_scattering_scale: 0.0331,
  dust_storm: 0.0,
};

export const SAFE_WEATHER_LIMITS: Record<string, readonly [number, number]> = {
  cloudiness: [0.0, 85.0],
  precipitation: [0.0, 70.0],
  precipitation_deposits: [0.0, 70.0],
  wind_intensity: [0.0, 80.0],
  sun_azimuth_angle: [-1.0, 360.0],
  sun_altitude_angle: [10.0, 90.0],
  fog_density: [0.0, 25.0],
  fog_distance: [25.0, 100000.0],
  fog_falloff: [0.05, 5.0],
  wetness: [0.0, 80.0],
  scattering_intensity: [0.5, 2.0],
  mie_scattering_scale: [0.0, 0.2],
  rayleigh_scattering_scale: [0.0, 0.08],
  dust_storm: [0.0, 30.0],
};

/** v1 safe_drive_weather: clamp every known key, defaulting missing/bad ones. */
export function safeDriveWeather(params: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, [lo, hi]] of Object.entries(SAFE_WEATHER_LIMITS)) {
    const fallback = DEFAULT_DRIVE_WEATHER[key]!;
    const raw = params?.[key];
    const parsed = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
    const value = Number.isFinite(parsed) ? parsed : fallback;
    out[key] = Math.max(lo, Math.min(hi, value));
  }
  return out;
}

export interface AppliedEnvironment {
  readonly timeOfDay: 'dawn' | 'noon' | 'dusk' | 'night';
  readonly weather: 'clear' | 'cloudy' | 'rain' | 'fog';
}

/** Map clamped protocol weather fields onto the engine environment. */
export function appliedEnvironment(safe: Record<string, number>): AppliedEnvironment {
  const altitude = safe['sun_altitude_angle'] ?? 75;
  const timeOfDay: AppliedEnvironment['timeOfDay'] =
    altitude < 0 ? 'night' : altitude < 15 ? ((safe['sun_azimuth_angle'] ?? 180) < 180 ? 'dawn' : 'dusk') : 'noon';
  const weather: AppliedEnvironment['weather'] =
    (safe['fog_density'] ?? 0) > 5 ? 'fog'
    : (safe['precipitation'] ?? 0) > 5 ? 'rain'
    : (safe['cloudiness'] ?? 0) > 40 ? 'cloudy'
    : 'clear';
  return { timeOfDay, weather };
}
