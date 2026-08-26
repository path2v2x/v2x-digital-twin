# V2X SimForge cutover status

**State:** SimForge-native twin is the only simulation runtime. The CARLA world,
Python bridge, external scenario-runner assets, and legacy SvelteKit/Amplify dashboard
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

- `apps/bridge` and all bridge requirements, tests, tools, legacy scenario
  files, external-runner patches, and its Dockerfile
- `apps/web` and the retired Amplify deployment/recovery surface
- obsolete simulator/bridge launch, wait, restart, and systemd units
- obsolete frontend-link repair and legacy dashboard service units
- stale CARLA operating procedures, generated browser evidence, and agent state

Remaining uses of the retired simulator's name are historical migration
lineage, preserved v1 wire-field names, coordinate compatibility names, or the
perception tool's explicit non-mutation statement. They do not identify a
runtime dependency.
