# Twin on SimForge OSS Studio plan

## Goal

Move the operator-facing twin experience into the Drive app at `simforge-oss/studio/app/dashboard/drive` while keeping `v2x-digital-twin` as the runtime and protocol owner. The dependency direction remains one way: this repository consumes `@simforge-oss/*`; SimForge OSS does not import this repository.

## Current split

| Surface | Current owner | Target owner |
|---|---|---|
| World simulation and fixed-step truth | `apps/twin-server` | unchanged |
| `/twin`, `/drive`, `/camera-feeds` | `apps/twin-server` | unchanged |
| Local detection mirroring | `apps/twin-server` consuming `path2v2x/co-perception` | unchanged |
| Camera MJPEG relay | `apps/twin-server` | unchanged |
| General world rendering and navigation | `apps/twin-web` | Studio Drive |
| V2X zone authoring | `apps/twin-web` | Studio Drive |
| 24-hour detection replay controls | `apps/twin-web` | Studio Drive |
| Trajectory selection and playback | `apps/twin-web` | Studio Drive |
| Low-level protocol diagnostics | `apps/dev-console` | unchanged |

`apps/twin-web` remains an interim client until the three V2X-specific surfaces are available in Studio Drive.

## Connection contract

Studio Drive receives its twin endpoint from:

```text
NEXT_PUBLIC_DRIVE_TWIN_URL=wss://twin.path2v2x.net/twin
```

The app derives the sibling `/drive` and `/camera-feeds` WebSockets from that origin. MJPEG URLs are advertised by the server and should be normalized to same-origin `/streams/` paths in browser deployments.

Studio must decode binary truth frames using `@simforge-oss/training-env`, render the world through `@simforge-oss/viewer`, and treat JSON messages as additive control and metadata. It must not build a second simulation model in the browser.

## Remaining work before cutover

1. Add polygon zone creation, editing, deletion, and `sync_v2x_zones` submission to Studio Drive.
2. Add replay date/time, speed, live-mode switching, and replay-status presentation.
3. Add trajectory listing, selection, start, stop, and active-state presentation.
4. Preserve camera feed-state labels and the single multiplexed WebSocket transport.
5. Exercise Studio Drive against the public nginx routes and the path-rfs 8865/8190 deployment.
6. Delete `apps/twin-web` only after the three missing surfaces pass an operator workflow smoke test.

## Ownership boundaries

Changes to simulation semantics, wire schemas, detection freshness, and camera transport belong in `v2x-digital-twin`. Reusable rendering, Studio interaction, and truth decoding belong in `simforge-oss`. Product-specific glue stays in the Drive app and must use the server's documented protocol rather than private server imports.
