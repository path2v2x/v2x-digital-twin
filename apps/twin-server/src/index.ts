/**
 * Bootstrap: SCEN_DEV_ASSETS must be set before @simforge/compiler is
 * imported (its dev-assets root is computed at module load), so the real
 * entrypoint is loaded dynamically after the env is prepared.
 */
import path from 'node:path';

const bundleDir = process.env['TWIN_MAP_BUNDLE'] ?? '/home/path/simforge-assets/map-bundles/richmond-field-station';
process.env['SCEN_DEV_ASSETS'] ??= path.dirname(bundleDir);

await import('./main.js');
