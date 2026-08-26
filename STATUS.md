# V2X SimForge cutover status

**State:** SimForge-native twin is the only simulation runtime. The CARLA world,
Python bridge, ScenarioRunner assets, and legacy SvelteKit/Amplify dashboard
have been removed.

## Active architecture

| Component | Responsibility | Interface |
|---|---|---|
| `apps/twin-server` | Shared SimForge engine world, drive sessions, twin sync, scenario templates, traffic, truth publication | WS `:8765` (`/drive`, `/twin`); HTTP `:8090` (MJPEG, health) |
| `apps/twin-web` | React/Three.js digital-twin client using `@simforge/viewer` | Vite `:5188` |
| `apps/perception` | Independent live camera ingestion and real object detection | Existing perception service/API |
| `apps/dev-console` | Low-level preserved `/drive` JSON protocol console | Defaults to `ws://localhost:8765/drive` |

The engine dependency is the pinned
[SimForgeinc/simforge](https://github.com/SimForgeinc/simforge) checkout described
in `apps/twin-server/README.md`. Native templates, trajectories, and traffic
profiles are self-contained under `apps/twin-server/assets`; no runtime path
points into the deleted bridge.

Protocol details and documented compatibility behavior are authoritative in
[docs/twin-protocol-v2.md](docs/twin-protocol-v2.md).

## The client is moving to SimForge Studio

The twin's user interface is becoming a first-class **Drive** app inside
`studio` in [SimForgeinc/simforge-oss](https://github.com/SimForgeinc/simforge-oss)
(branch `feat/drive-continuous-world`), rather than a local look-alike of the
editor. `apps/twin-web` was a hand-written imitation: 3,496 lines under `src`,
of which 2,342 (66.99%) were presentational chrome and CSS re-implementing the
top bar, tool rail, inspector, timeline, toasts, icons and token system that
Studio already ships.

Studio's Drive app attaches to this server as a `WorldSource`: truth over
`ws://<host>:8765/twin`, commands over `/drive`, and camera feeds proxied
same-origin from `:8090`. Verified against this server on 2026-08-25 — world
clock 4,154.6 s at tick 83,093, `cam-001-ch1` live with a truthful badge and a
single MJPEG connection open.

Camera calibration is no longer client constants. `config/cameras.json` binds
the mast to `traffic_light` SignalFeature **372** (measured 0.7 m from the
surveyed position) and `buildTwinCameras` emits rigs in the shape
`@simforge/maps` consumes, so pose derives from map geometry. The feature's
`z_offset` is the signal head at 4.48 m and is *not* the camera height; each
channel keeps its own 7 m mount.

### `apps/twin-web` is retained deliberately

It still uniquely owns product surfaces that Studio Drive does not yet provide,
so deleting it now would lose function:

| Surface | Where |
|---|---|
| V2X zone drawing and `sync_v2x_zones` | `src/state/zones.ts`, `src/components/shell/ZoneOverlay.tsx` |
| 24-hour replay control (`twin_replay`) | `src/App.tsx:92-96` |
| Trajectory playback trigger (`start_trajectory`) | `src/App.tsx:140` |

EVA alerts, ghost mirroring, traffic presets and local publication are
server-side and already work for either client. `apps/twin-web` should be
deleted once zones, replay and trajectories exist on the Studio surface — not
before.

## Local operation

From the repository root:

```bash
pnpm dev
```

The root script starts only `apps/twin-server` and `apps/twin-web`. MJPEG is
served by twin-server; no separate simulator process or bridge launcher is
required. The independent perception pipeline remains available through
`scripts/launch-perception.sh`.

## Cutover verification

Verified after deletion on 2026-08-25:

- `pnpm --dir apps/twin-server test`: **6 test files passed, 19/19 tests passed**.
- `pnpm --dir apps/twin-web build`: **passed** (`tsc -b && vite build`, 147 modules transformed).
- `npx vite build` in `apps/dev-console`: **passed** (1,810 modules transformed).
- focused TypeScript check for `apps/dev-console/src/{main,App}.tsx`: **passed**.
- root `package.json` `dev` script references only the living twin-server and
  twin-web paths.

The twin-web build reports Vite's existing large-chunk advisory for the bundled
viewer; it is not a build failure.

## Removed surfaces

- `apps/bridge` and all bridge requirements, tests, tools, `.xosc` scenarios,
  ScenarioRunner patches, and its Dockerfile
- `apps/web` and the retired Amplify deployment/recovery surface
- obsolete simulator/bridge launch, wait, restart, and systemd units
- obsolete frontend-link repair and legacy dashboard service units
- stale CARLA operating procedures, generated browser evidence, and agent state

Remaining uses of the retired simulator's name are historical migration
lineage, preserved v1 wire-field names, coordinate compatibility names, or the
perception tool's explicit non-mutation statement. They do not identify a
runtime dependency.
