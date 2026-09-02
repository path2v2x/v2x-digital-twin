import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const MAP_BUNDLE = process.env.SIMFORGE_MAP_BUNDLE ?? '/home/path/simforge-oss/dev-assets/richmond-field-station';
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
        const target = relative === '/browser-manifest'
          ? join(MAP_BUNDLE, 'browser-manifest')
          : join(MAP_BUNDLE, 'browser/3d', relative);
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
  server: {
    host: true,
    port: 5188,
    strictPort: true,
    allowedHosts: true,
    // Same-origin everything: the browser only ever talks to :5188. WS and MJPEG
    // are proxied so remote (tailnet) access has no cross-origin request at all.
    proxy: {
      '/twin': { target: 'ws://localhost:8765', ws: true },
      '/drive': { target: 'ws://localhost:8765', ws: true },
      '/streams': { target: 'http://localhost:8090', changeOrigin: true },
      '/health': { target: 'http://localhost:8090', changeOrigin: true },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
