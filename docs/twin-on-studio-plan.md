# Twin on SimForge OSS Studio plan

## Goal

Move the operator-facing twin experience into the Drive app at
`simforge-oss/studio/app/dashboard/drive` while keeping `v2x-digital-twin` as
the runtime and protocol owner. The dependency remains one way: this repository
consumes SimForge packages; SimForge OSS does not import this repository.

## Cutover status

Completed. `twin.path2v2x.net` serves Studio Drive in its generic standalone
mode. Studio attaches to the existing `/twin`, `/drive`, and `/camera-feeds`
WebSockets and same-origin `/streams/` routes. The interim `apps/twin-web`
client and its deployment root have been removed.

| Surface | Owner after cutover |
|---|---|
| World simulation and fixed-step truth | `apps/twin-server` |
| `/twin`, `/drive`, `/camera-feeds`, `/streams/` | `apps/twin-server` |
| Local detection mirroring | `apps/twin-server` consuming `path2v2x/co-perception` |
| World rendering, Drive controls, timeline, replay, and cameras | SimForge Studio Drive |
| Low-level protocol diagnostics | `apps/dev-console` |

## Deployment contract

Studio receives the twin origin from:

```text
NEXT_PUBLIC_DRIVE_TWIN_URL=wss://twin.path2v2x.net
```

The app appends the protocol paths. `SIMFORGE_TWIN_HTTP_ORIGIN` points at the
loopback twin HTTP server for same-origin MJPEG rewrites. The Richmond manifest,
lane index, and camera rig are configured with the corresponding
`NEXT_PUBLIC_DRIVE_MAP_*` variables. `NEXT_PUBLIC_DRIVE_STANDALONE=1` removes
Studio navigation, and `NEXT_PUBLIC_DRIVE_HOME_URL=https://path2v2x.net/` adds
the sole external header link.

## Remaining work

There is no remaining cutover work in this repository. Future simulation
semantics, wire schemas, detection freshness, and camera transport changes
belong here. Reusable rendering and Drive interaction changes belong in
`SimForgeinc/simforge-oss`. Studio workers and render pipelines are explicitly
outside this deployment.
