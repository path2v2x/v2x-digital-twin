# v2x-digital-twin

SimForge-native digital twin for the Richmond Field Station V2X deployment. The server owns simulation truth, mirrors detections from the local co-perception service, and serves drive control, truth frames, and camera feeds. Historical lineage: CARLA is not used by this repository or its runtime.

## Architecture

| Component | Responsibility | Default interface |
|---|---|---|
| `apps/twin-server` | SimForge OSS world, drive commands, truth publication, local detection mirroring, MJPEG relay | WS `:8765` at `/twin`, `/drive`, `/camera-feeds`; HTTP `:8090` at `/health`, `/streams/` |
| `apps/twin-web` | Interim Vite/React/Three.js client | HTTP `:5188` |
| `apps/dev-console` | Low-level `/drive` protocol console | Vite development server |
| SimForge Studio Drive | Target user interface in `simforge-oss/studio/app/dashboard/drive` | Set `NEXT_PUBLIC_DRIVE_TWIN_URL` to the public `/twin` WebSocket URL |

`path2v2x/co-perception` is the only perception implementation. It is a separate repository and process.

## SimForge OSS dependency

The dependency flow is one way: this repository consumes `SimForgeinc/simforge-oss`; `simforge-oss` does not consume code from this repository. The packages are not fetched from a registry. They are built and packed from the pinned open-source ref:

```bash
scripts/vendor-simforge-oss.sh v0.1.0-rc.60
```

Set `SIMFORGE_OSS_DIR` to use a different existing checkout; it defaults to `/home/path/simforge-oss`. If no checkout exists, the script clones `https://github.com/SimForgeinc/simforge-oss.git` into a temporary directory. It installs with the upstream frozen lockfile, builds the required dependency closure, packs seven packages into `vendor/simforge-oss`, and records the ref, commit, package names, and versions in `vendor/simforge-oss/LOCK.json`.

`v0.1.0-rc.60` is used because it is the newest repository tag and all required packages build there. The compiler still exports `@simforge-oss/compiler/node`, which the server uses. Packed manifests contain only built `dist` export targets, so no postinstall export repair is needed.

The seven archives are each below 10 MB and are committed. A fresh install therefore does not require an npm registry for any `@simforge-oss/*` package.

## Local operation

Prerequisites are Node.js, pnpm, ffmpeg, and the Richmond Field Station map bundle. From the repository root:

```bash
pnpm install
pnpm dev
```

Focused commands:

```bash
pnpm --dir apps/twin-server start
pnpm --dir apps/twin-server typecheck
pnpm --dir apps/twin-server test
pnpm --dir apps/twin-web build
```

Default ports are configurable:

| Variable | Default | Purpose |
|---|---:|---|
| `TWIN_WS_PORT` | `8765` | `/twin`, `/drive`, and `/camera-feeds` WebSockets |
| `TWIN_HTTP_PORT` | `8090` | health and MJPEG streams |
| `TWIN_MAP_BUNDLE` | `assets/richmond-field-station/bundle` | logical map bundle: `map.xodr`, `topology-index.json.gz`, `signals.geojson.gz`, `derived/{topology-derived,locations}.json.gz` (no 3D tiles; produced by the simforge-oss map pipeline, see `derived/map-intel-build-receipt.json`) |
| `TWIN_SYNC_LOCAL` | `0` | enable local detection polling |
| `TWIN_DETECTIONS_URL` | `http://127.0.0.1:8090/detections/latest` | co-perception summary endpoint |
| `TWIN_CAMERA_URL_TEMPLATE` | `rtsp://127.0.0.1:8554/{channel}` | ffmpeg input URL template |
| `TWIN_LIVE_FEEDS` | `1` | use local live camera inputs; set `0` for recorded replay only |

## Local detections contract

When `TWIN_SYNC_LOCAL=1`, `apps/twin-server/src/twinsync.ts` polls `GET $TWIN_DETECTIONS_URL`. `path2v2x/co-perception` must expose this response shape:

```json
{
  "cameras": {
    "ch1": {
      "ts": 1788200000.25,
      "detections": [
        {
          "object_id": "track-17",
          "object_type": "car",
          "confidence": 0.93,
          "gps_location": { "lat": 37.9155, "lon": -122.3345 }
        }
      ]
    }
  }
}
```

`ts` is epoch seconds. Camera summaries more than eight seconds old or more than five seconds in the future are ignored. Each accepted detection needs an `object_id` and `gps_location.lat`/`gps_location.lon`.

## Camera source contract

`TWIN_CAMERA_URL_TEMPLATE` is substituted once per channel using `ch1` through `ch4`. Examples:

- `rtsp://127.0.0.1:8554/{channel}` for MediaMTX or go2rtc;
- `http://127.0.0.1:8081/{channel}` for a local HTTP stream source.

ffmpeg uses `-rtsp_transport tcp` for `rtsp://` URLs. If a live input exits or cannot produce frames, the server falls back to the recorded footage loop and retries the local live source after five minutes. Clients receive MJPEG at `/streams/ch1.mjpg` through `/streams/ch4.mjpg` or multiplexed binary frames at `/camera-feeds`.

## path-rfs deployment

On path-rfs the CARLA drive server (`path2v2x/v2x-drive`) owns `:8765`, and `:8090` was the retired perception service's port. The twin therefore runs there with:

```text
TWIN_WS_PORT=8865
TWIN_HTTP_PORT=8190
TWIN_SYNC_LOCAL=1
TWIN_DETECTIONS_URL=http://127.0.0.1:8090/detections/latest
TWIN_CAMERA_URL_TEMPLATE=rtsp://127.0.0.1:8554/{channel}
```

Install `scripts/systemd/v2x-twin-server.service` after selecting the correct `path` or `jpark` service account. `deploy/nginx-twin.conf` proxies `twin.path2v2x.net` WebSockets to `:8865` and `/streams/` to `:8190`. Adjust the detections URL if co-perception binds a different local port.

Protocol details are in [docs/twin-protocol-v2.md](docs/twin-protocol-v2.md). The Studio migration plan is in [docs/twin-on-studio-plan.md](docs/twin-on-studio-plan.md).
