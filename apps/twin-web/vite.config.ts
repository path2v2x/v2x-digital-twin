import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const MAP_BUNDLE = process.env.SIMFORGE_MAP_BUNDLE ?? '/home/path/simforge-assets/map-bundles/richmond-field-station';
const MIME: Record<string, string> = {
  '.json': 'application/json', '.gz': 'application/gzip', '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2', '.webp': 'image/webp', '.xodr': 'application/xml',
};

function mapBundlePlugin(): Plugin {
  return {
    name: 'v2x-map-bundle',
    configureServer(server) {
      server.middlewares.use('/map', (request, response, next) => {
        const relative = normalize(decodeURIComponent((request.url ?? '/').split('?')[0])).replace(/^(\.\.(\/|\\|$))+/, '');
        const target = join(MAP_BUNDLE, relative === '/' ? 'browser-manifest' : relative);
        if (!target.startsWith(MAP_BUNDLE)) return next();
        try {
          if (!statSync(target).isFile()) return next();
          response.setHeader('Content-Type', MIME[extname(target)] ?? 'application/octet-stream');
          response.setHeader('Cache-Control', 'public, max-age=3600');
          createReadStream(target).pipe(response);
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), mapBundlePlugin()],
  server: { port: 5188, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
