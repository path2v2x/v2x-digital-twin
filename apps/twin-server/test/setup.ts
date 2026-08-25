// SCEN_DEV_ASSETS must exist before @simforge/compiler is imported anywhere.
import path from 'node:path';

const bundleDir = process.env['TWIN_MAP_BUNDLE'] ?? '/home/path/simforge-assets/map-bundles/richmond-field-station';
process.env['SCEN_DEV_ASSETS'] ??= path.dirname(bundleDir);
