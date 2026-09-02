# v2x-digital-twin status

## Current state

The digital twin runs entirely on vendored `@simforge-oss/*` packages. Historical lineage: the former CARLA runtime, cloud ingest surfaces, bundled perception copy, and tunnel deployment scripts have been removed.

| Surface | State |
|---|---|
| `apps/twin-server` | Active; shared world, `/twin`, `/drive`, `/camera-feeds`, `/streams/`, local detection sync, replay |
| `apps/twin-web` | Active interim client until Studio Drive covers zones, replay, and trajectories |
| `apps/dev-console` | Active developer protocol console |
| `path2v2x/co-perception` | External and authoritative for live detections |
| SimForge Studio Drive | Target UI at `simforge-oss/studio/app/dashboard/drive`; configured with `NEXT_PUBLIC_DRIVE_TWIN_URL` |

## Dependency pin

`vendor/simforge-oss/LOCK.json` pins `v0.1.0-rc.60` at commit `be6e51503c09217ed73ef2b0b2fa06841159e29e`. It is the newest tag and successfully builds the required `engine`, `compiler`, `maps`, `training-env`, `viewer`, `asset-catalog`, and `scenario` packages. All packed archives are committed because each is below 10 MB. The pack process removes source-only development export conditions and preserves the compiler `/node` subpath.

Regenerate the dependency set with:

```bash
scripts/vendor-simforge-oss.sh v0.1.0-rc.60
pnpm install
```

## Runtime contracts

The server defaults to WS 8765 and HTTP 8090, with `TWIN_WS_PORT` and `TWIN_HTTP_PORT` overrides. On path-rfs it uses 8865 and 8190 because the drive application owns the default pair.

Local detections are enabled with `TWIN_SYNC_LOCAL=1`. `GET $TWIN_DETECTIONS_URL` must return `{"cameras":{"<camId>":{"ts":<epoch seconds>,"detections":[{"object_id":"...","gps_location":{"lat":0,"lon":0}}]}}}`. This is the interface `path2v2x/co-perception` must expose.

Live camera inputs use `TWIN_CAMERA_URL_TEMPLATE`, defaulting to `rtsp://127.0.0.1:8554/{channel}`. The server uses TCP for RTSP, publishes MJPEG itself, falls back to recorded footage, and periodically retries the local source.

## Deployment

`scripts/systemd/v2x-twin-server.service` runs the server from `/home/path/v2x-digital-twin` with ports 8865/8190, local detection sync, and local camera URLs. `deploy/nginx-twin.conf` exposes `/twin`, `/drive`, `/camera-feeds`, and `/streams/` at `twin.path2v2x.net`. The service account and local co-perception port must match the path-rfs host before installation.
