# v2x-digital-twin status

## Current state

The digital twin runtime remains the protocol and truth owner. The operator UI
is now SimForge OSS Studio Drive; the interim `apps/twin-web` client has been
removed.

| Surface | State |
|---|---|
| `apps/twin-server` | Active on path-rfs; shared world, `/twin`, `/drive`, `/camera-feeds`, `/streams/`, local detection sync, replay |
| SimForge Studio Drive | Active from `/home/path/simforge-oss/studio` on loopback `:5199`; standalone UI at `twin.path2v2x.net` |
| `apps/dev-console` | Active developer protocol console |
| `path2v2x/co-perception` | External and authoritative for live detections |

## Dependency pin

`vendor/simforge-oss/LOCK.json` pins the runtime package set at
`v0.1.0-rc.60`. That pin is independent of the Studio checkout used for the UI.
Regenerate the runtime dependency set with:

```bash
scripts/vendor-simforge-oss.sh v0.1.0-rc.60
pnpm install
```

## Runtime contracts

The server defaults to WS 8765 and HTTP 8090. On path-rfs it uses 8865 and 8190
because the drive application owns the default pair. Local detections come from
`GET $TWIN_DETECTIONS_URL`; camera inputs use
`TWIN_CAMERA_URL_TEMPLATE`, with recorded fallback managed by the server.

## Deployment

`scripts/systemd/v2x-twin-server.service` runs the existing twin server.
`deploy/v2x-twin-studio.service` runs the standalone Studio checkout and
`deploy/studio.env.example` records its public twin, map, camera-rig, and Home
configuration. `deploy/nginx-twin.conf` routes the protocol endpoints directly
to the twin server and all remaining UI requests to Studio on loopback `:5199`.
The Studio port is blocked on the external interface by the v2x-drive firewall.
