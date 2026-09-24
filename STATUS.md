# V2X Digital Twin status

## Current state

This repository is a standalone product: it owns the twin runtime, the wire
protocol, and the operator UI. SimForge OSS code is consumed only as frozen
vendored packages.

| Surface | State |
|---|---|
| `apps/twin-server` | Active on path-rfs (`v2x-twin-server`, WS `:8865`, HTTP `:8190`); shared live world re-rooted every 600 s, `/twin`, `/drive`, `/camera-feeds`, `/streams/`, local detection sync, 72-hour history and replay |
| `apps/twin-web` | Active on path-rfs (`v2x-twin-web`, loopback `:5199`) behind `twin.path2v2x.net`; live world view, pole-camera strip, Live/replay timeline, scenario editor |
| `apps/dev-console` | Developer `/drive` protocol console |
| `path2v2x/co-perception` | External and authoritative for live detections (`:8091`) and live camera frames (`/tmp/coperception_output.sock`); currently served on path-rfs by the `jpark-co-perception` service, with this repository's `v2x-perception` unit stopped |

## Dependency pin

`vendor/simforge-oss/LOCK.json` pins the vendored SimForge OSS packages
(`0.1.0-rc.60`) to commit `c7277f44`. The fork is frozen; changes are not
contributed upstream. Regenerate the archives with:

```bash
make vendor
pnpm install
```

## Runtime contracts

The server defaults to WS 8765 and HTTP 8090. On path-rfs it uses 8865 and 8190
because the drive application owns the default pair. Local detections come from
`GET $TWIN_DETECTIONS_URL`; live camera frames come from
`TWIN_CAMERA_SOCKET_PATH` when set, otherwise from `TWIN_CAMERA_URL_TEMPLATE`,
with recorded fallback managed by the server. `/health` reports
`engine: "v2x-twin"`.

## Deployment

`scripts/deploy.sh [--web] [--perception] [--dry-run]` deploys `origin/main` on
path-rfs. `scripts/systemd/v2x-twin-server.service` runs the twin server;
`deploy/v2x-twin-web.service` runs the web UI with `/etc/v2x-twin-web.env`
(template: `deploy/twin-web.env.example`). `deploy/nginx-twin.conf` routes the
protocol endpoints to the twin server, serves `/map-bundles/` from
`/var/www/v2x-twin-map-bundles/` and `/drive-rigs/richmond.json` from the
checkout, and proxies all remaining requests to the web UI. The web UI port is
blocked on the external interface by the v2x-drive firewall.
