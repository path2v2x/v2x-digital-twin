# V2X SimForge Digital Twin

This repository runs the Richmond Field Station V2X digital twin on the
[SimForgeinc/simforge](https://github.com/SimForgeinc/simforge) engine. The
runtime is fully SimForge-native; the former CARLA bridge and SvelteKit
dashboard have been removed.

## Architecture

- `apps/twin-server` owns engine truth and serves WebSocket protocols on
  `:8765` (`/drive` and `/twin`) plus MJPEG camera streams on `:8090`.
- `apps/twin-web` is the React/Three.js client built on `@simforge/viewer`.
- `apps/perception` is the real detection source. It consumes the live camera
  pipeline and publishes detections independently of the simulation engine.
- `apps/dev-console` is a developer tool for exercising the preserved `/drive`
  JSON protocol.

The wire contract, compatibility behavior, transports, and known degraded
operations are documented in [docs/twin-protocol-v2.md](docs/twin-protocol-v2.md).

## Run the local twin

Prerequisites:

- Node.js and pnpm
- the pinned `SimForgeinc/simforge` engine worktree expected by
  `apps/twin-server`
- the Richmond Field Station SimForge map bundle

Install each application as needed, then start the complete stack from the
repository root:

```bash
pnpm dev
```

That command starts only living applications:

- twin-server WebSocket: `ws://localhost:8765/drive` and
  `ws://localhost:8765/twin`
- twin-server MJPEG/health: `http://localhost:8090`
- twin-web: `http://localhost:5188`

Focused commands:

```bash
pnpm run dev:server
pnpm run dev:web
pnpm run test:server
pnpm --dir apps/twin-web build
```

Equivalent convenience targets are available through `make help`.

## Repository layout

```text
apps/
  twin-server/   SimForge world, /drive + /twin WebSockets, MJPEG publication
  twin-web/      Three.js/@simforge/viewer digital-twin client
  perception/    Live camera ingestion and object detection
  dev-console/   Low-level /drive protocol console
assets/
  richmond-field-station/  Source map artifacts
config/
  cameras.json   Preserved camera configuration
infra/
  aws-cli/       V2X cloud ingestion/state provisioning
scripts/
  systemd/       Surviving perception and transport units
```

## Engine and map dependencies

`twin-server` consumes a pinned SimForge engine checkout through pnpm file
references. See `apps/twin-server/README.md` for the expected worktree and map
bundle locations. The server's native scenario templates, trajectories, and
traffic presets live under `apps/twin-server/assets`; runtime code does not
read from retired bridge paths.

## Perception

`apps/perception` remains the production detection source. Its Python
requirements, launch helper, tests, calibration assets, and historical
operational notes are intentionally retained. Start it independently when the
live camera pipeline is required:

```bash
./scripts/launch-perception.sh
```

The root `pnpm dev` command boots the simulation server, its MJPEG publication,
and the web client; it does not replace the external live perception process.
