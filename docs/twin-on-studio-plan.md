# The V2X twin as a SimForge Studio surface

Status: plan, pending Michael's sign-off on the open questions at the end.

## The mistake this replaces

`apps/twin-web` is a hand-written Vite app that *imitates* the editor: 3,496 lines under `src/**`, of
which 2,342 (66.99%) are presentational chrome and CSS. It reimplements the top bar, tool rail,
inspector, timeline dock, toasts, icons, fonts and the whole token system, and it hand-rolls viewer
setup that `@simforge/viewer` already owns. It can never match the real editor and it drifts every
time Studio changes. It gets deleted.

The root cause was my instruction to the UX lanes: "no Tailwind, hand-write the CSS." Studio is
Next.js + React 19 + **Tailwind 3.4.19** + shadcn (`studio/components.json`) with tokens in
`studio/app/globals.css`. That instruction guaranteed a lookalike.

## What the editor actually is

The decisive finding: **the editor is not a separate app or even its own route.** It is an in-place
mode of `/dashboard/scenario`, layered over *one* permanently mounted shared `CityViewer`.

- `studio/app/dashboard/scenario/editor/page.tsx:5-19` — the `/editor` route is deep-link
  compatibility only; it redirects to `/dashboard/scenario?...`.
- `studio/app/dashboard/scenario/ScenarioDatasetsClient.tsx:114-123` — editor visibility is
  `openDocumentId` React state. `:166-169` — idle preview and authoring are two controllers over one
  persistent world. `:517-518` — the root publishes `data-workspace-mode`. `:698-713` — editor chrome
  is an absolute overlay above the mounted workspace.
- `studio/app/dashboard/scenario/editor/shell/ScenarioEditorShell.tsx:22-44` — the shell is
  **runtime-free geometry and slots**: `header`, `leftSidebar`, `canvas`, `statusOverlay`,
  `floatingOverlay`, plus `canvasMode: 'interactive' | 'passthrough'`. It never conditions the canvas.
- `studio/app/dashboard/scenario/editor/regions/EditorCanvasRegion.tsx:48-49,67-89` — an
  `externalWorld` creates no second viewer; it passes through to the shared one.

So DRIVE and CAMERAS are not new applications. They are **additional modes in a pattern the editor
already proves**, and the twin becomes Studio rather than resembling it.

The `@simforge/editor` package is framework-neutral (authoring document, interaction controller,
contracts) and contains **zero `.tsx` files** — the React UI exists only inside `studio/`. That is why
"consume the editor as a package" is not available and why the surface must live in Studio.

## The hard boundary: live truth is not a document

This constrains the whole design and must not be violated.

- `packages/scenario/src/schema/v2/template.ts:1-17` — `ScenarioTemplateV2` is explicitly the
  *authored* portable document. `packages/editor/src/document.ts:1-15` — `EditorDocument` is "the
  editor's view of a canonical ScenarioTemplate v2", with undo and autosave.
- There is no tick, time, observation, velocity/acceleration, live signal snapshot or subscription
  field anywhere in those contracts.
- `studio/app/lib/scenario/editor/use-editor-runtime.ts:116-136,152-176` — the runtime *always*
  constructs an `EditorDocument` and cannot build an `EditorController` without lane index + document.
  `ScenarioTimelineDock.tsx:42-56` requires an `EditorDocument`; the rail, inspectors and tutorial all
  read and mutate it.

Consequence: **we do not manufacture an `EditorDocument` from truth frames.** Mirroring observations
into the authored document would misclassify them as edits and engage undo/autosave. We reuse the
shell, the shared viewer and the chrome, and introduce a genuine live-world controller as a *sibling*
of `EditorController`. In live modes the authoring regions are omitted, not faked.

## What we consume instead of writing

Every item below is code twin-web currently duplicates.

| Need | Existing API | twin-web duplicate to delete |
| --- | --- | --- |
| Truth wire decode | `TruthStreamClient`, `TruthFrame` — `packages/training-env/src/truth-stream.ts:184-262`; framing `u32 LE + msgpack`, 64 MiB cap, arbitrary chunking | `src/lib/truth.ts` (85 lines) |
| Truth subscription | `WorldSession.subscribeTruth` `world-session.ts:342-350`; `WorldRegistry.subscribeTruth` `session-registry.ts:185-193` | — (server already uses it) |
| Actor sync to scene | `ThreeRendererAdapter.applyActorFrame` `renderer-contract-adapter.ts:170-173` → `ActorRenderer.syncLayer` `actorRenderer.ts:589-612` | `TwinScene.tsx` local `ActorRenderer` + `sync` |
| Drive camera | `followCameraPose(actor, 'chase' \| 'dash')` `renderer-contract.ts:136-144`, applied at `renderer-contract-adapter.ts:143-148` | `TwinScene.tsx:134-179` hand-rolled follow |
| Terrain lift | `indexedWorldHeightSampler(viewer)` `indexed-height-sampler.ts:3-33`; `buildGroundIndex`/`getGroundIndex` `viewer.ts:1927-1959`; `GroundIndex.sample/sampleNear` `ground-index.ts:368-386` | per-actor per-frame `sampleGroundHeight` in `TwinScene.tsx:95-133` |
| Canvas mount | `CityView` from `@simforge/viewer/react` via `EditorCanvasRegion` | `TwinScene.tsx:187-208` bespoke setup |
| Camera pose save/restore | `viewer.captureView/applyView` `viewer.ts:472-479`; `viewer.setCameraMode` via `ViewportSettingsPanel.tsx:81-86` | ad-hoc constraint disabling in `lib/cameras.ts` |
| Chrome, tokens, toasts, fonts | `ScenarioEditorShell`, `dashboard/layout.tsx` `AppTopBar`/`TopBarSlot`, root Sonner toaster, `globals.css` + `tailwind.config.js` | `index.css` (1,323) + `views/canvas.css` (204) + `shell/*` + `icons.tsx` |

Note the terrain-lift upgrade: the ground **index** is the right API for a per-frame whole-scene lift;
twin-web raycast per actor per frame.

## Blocker that belongs upstream

The twin-server wedge is not my server's bug. It is in engine code:

```
packages/training-env/src/world-session.ts:269-286
  this.sim = this.buildSim();
  this.consumeWarmup();
  if (this.tickCount > 0) this.sim.advance(this.tickCount);
```

`applyStructural` (`:448-552`) calls that `rebuild` for **every** spawn/despawn/batch, so each
structural command replays the entire elapsed history: O(warmup + tickCount). `snapshot()` (`:352-373`)
is a read-only actor projection; `exportLog()` (`:374-389`) is replay history. There is **no** state
import, checkpoint, restore or re-baseline API anywhere in the package. Non-structural `act` is
incremental and cheap.

At 20 Hz this is why the twin wedges after ~20 minutes (97% CPU, 1.6 GB RSS, `/drive` never opens).
Every ghost, traffic actor, placement and trajectory goes through it. It must be fixed in
`@simforge/training-env` — bounded structural mutation or a restorable state snapshot — before any
long-lived twin surface is credible. No workaround in product code.

## Phases

**P0 — Topology.** Branch `simforge-oss` for the live-world surface. Studio dev server proxies
`/twin`, `/drive`, `/streams`, `/health` to twin-server (:8765/:8090) via `next.config.ts` rewrites,
preserving the zero-CORS same-origin rule. Root `pnpm dev` in v2x-backend runs twin-server + Studio.

**P1 — Engine: bound the structural rebuild.** Fix `world-session.ts` so spawn/despawn is O(1) in
elapsed ticks. Keep determinism and the frozen truth wire byte-identical. This gates everything.

**P2 — Live-world plane in Studio.** `LiveWorldClient` (WS + `TruthStreamClient`) and a
`LiveWorldController` sibling to `EditorController` that drives `applyActorFrame` and the ground index.
Includes the reconnect state machine twin-web **never had** (`state/twin.ts:50-80,121-150` create each
socket once, with no retry, backoff or generation) — an honest gap, not a port.

**P3 — Mode registry.** Extend the existing `ScenarioDatasetsClient` mode union and
`data-workspace-mode` with LIVE / DRIVE / CAMERAS, composing `ScenarioEditorShell` slots. Authoring
regions omitted in live modes. Precedent to follow: playback's `inspecting`/`presenting` states, where
playback owns actors and camera and the authoring rail hides (`ScenarioEditorSurface.tsx:899-901`,
`camera-framing.ts:186-207`). Single-writer arbitration between live truth, editor playback and idle
preview is mandatory — they cannot all write actors and camera.

**P4 — DRIVE.** 20 Hz keyboard → `control`, preserving the stuck-throttle invariant: the effect
depends on the stable `drive.transmit` identity, never the socket object (`DriveView.tsx:36-42,91`).
Camera via `followCameraPose`. Telemetry HUD in Studio chrome — speed is **already km/h**
(`drive.ts:369-370`), never multiply by 3.6.

**P5 — CAMERAS.** Four calibrated real/twin pairs with truthful `feed_mode` badges (never inferred).
Fix the connection starvation properly: four `multipart/x-mixed-replace` responses with
`Connection: close` (`mjpeg.ts:181-192`) occupy four of Chrome's six per-host HTTP/1.1 slots and starve
map tiles. Multiplex frames over the existing `/twin` socket → one connection for four feeds.

**P6 — V2X product layer.** Stays in v2x-backend: KVS/MJPEG, ghosts + expiry, EVA/zones alerts,
trajectories, local publication. Richmond calibration becomes configuration passed into the surface.

**P7 — Cutover.** Delete `apps/twin-web`. Rewrite `STATUS.md`. Fix the doc/code divergences found:
`docs/twin-protocol-v2.md:340-343` claims S3 upload that `publication.ts:53-60` explicitly does not
perform; `:57-58` says start/end make "ghost actors" but `drive.ts:250-280` makes static
`category:'reconstruction'` actors; `:170-174` lists generic blueprint ids while `drive.ts:31-49`
returns ten named legacy vehicles; `:295-296` says truth is suppressed for `?control=1` but
`server.ts:37-45` always relays it. Also dead client listeners: `state/twin.ts:61-63` listens for
`eva_alert`/`telemetry` on `/twin`, which the server never sends there.

## Open questions

1. **OpenSCENARIO** — I misread an instruction and purged the term from the twin; that is reverted
   (`b3fdc8b`). What did you actually mean? `@simforge/openscenario` is load-bearing upstream for
   import/export, browser capture and the compiler path (`studio/app/api/simforge/imports/openscenario/route.ts:7-9`,
   `studio/worker/compiler-core.ts:5-8`, `packages/playback/src/replay-bundle.ts:25-29`) — but not for
   the editor's authoring document, controller or the live truth path.
2. **Branch and PR topology** in `SimForgeinc/simforge-oss`: feature branch merged to `main`, or a
   long-lived branch? Do I have push access there?
3. **Is CAMERAS acceptable upstream** as a generic "calibrated reference-camera comparison" feature,
   with Richmond calibration supplied as product config? The mechanism is generic site-twin
   validation; only the calibration data is V2X.
