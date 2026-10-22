# V2X Digital Twin

Digital twin for the Richmond Field Station V2X deployment. The twin server owns simulation truth, mirrors detections from the local co-perception service, records detection history for replay, and serves drive control, truth frames, and camera feeds. The web UI picks a recorded window of up to 60 s from the camera archive and detection history, then simulates it in the browser: recorded detections become read-only actors, the pole-camera footage plays in sync, and the user adds their own actors. A second page, `/review`, is a detection review: the past hour of detections on one timeline and, for any instant, the annotated footage of one pole camera. CARLA is not used by this repository or its runtime.

## Architecture

| Component | Responsibility | Default interface |
|---|---|---|
| `apps/twin-server` | Shared simulation world, drive commands, truth publication, 72-hour detection history/replay, local detection mirroring, camera relay | WS `:8765` at `/twin`, `/drive`, `/camera-feeds`; HTTP `:8090` at `/health`, `/streams/`, `/detections/` |
| `apps/twin-web` | Operator UI (Next.js), two views. Pick: one row of detected events over the past hour across all cameras, colour-coded by kind (pedestrian, cyclist, car, truck/bus), each block spanning exactly its detections (at least 2 px wide; the server drops detections shorter than 2 s), with recording gaps hatched (wheel to zoom, click outside detections to move the playhead there and keep playing or paused, drag to select ≤60 s; Play runs from the playhead). Clicking a detection plays it from its first detection, selects exactly its span (first 60 s of longer ones) and shows two equal panes, the twin looking through the event's busiest camera (recorded actors sampled at the playhead) and that camera's footage, played in sync; keys 1–4 switch camera, Esc closes. Edit: scenario editor over the selected window, recorded actors replayed by an in-browser simulation alongside user-placed actors, archive footage in sync with play/stop. `/review`: detection review, the selected camera's annotated footage filling the page, opening paused on the start of the latest detection; clicking a detection plays it from its start (on a camera that saw it), and clicking or dragging anywhere else moves the playhead there; Space plays/pauses, ←/→ step 1 s, 1–4 switch camera; `?at=<ISO>&camera=chN` opens a given instant | HTTP `:5199` |
| `apps/dev-console` | Low-level `/drive` protocol console | Vite development server |

`path2v2x/co-perception` is the only perception implementation. It is a separate repository and process.

The world session runs in live mode and is re-rooted onto a fresh engine session every `TWIN_SESSION_EPOCH_SECONDS` (600 s) so spawn cost does not grow with uptime.

## Vendored SimForge OSS packages

The simulation engine, map, scenario, editor, and playback libraries are consumed as a frozen fork of `SimForgeinc/simforge-oss`: packed tarballs committed under `vendor/simforge-oss`, built from commit `c7277f44` and recorded in `vendor/simforge-oss/LOCK.json`. Nothing is fetched from a registry and nothing is contributed back upstream. The `@simforge-oss/*` package names are kept as-is.

To regenerate the archives (only needed to move the pin):

```bash
make vendor            # scripts/vendor-simforge-oss.sh c7277f44
pnpm install
```

The script clones `SIMFORGE_OSS_DIR` (default `/home/path/simforge-oss`) or, if absent, `https://github.com/SimForgeinc/simforge-oss.git` into a temporary directory, checks out the ref, builds the package closure, publishes every non-development export subpath, packs the packages into `vendor/simforge-oss`, and rewrites `LOCK.json`.

## Local development

Prerequisites are Node.js, pnpm, and ffmpeg. The Richmond Field Station logical map bundle is committed at `assets/richmond-field-station/bundle`. From the repository root:

```bash
pnpm install
pnpm dev               # twin server (same as pnpm dev:server)
pnpm dev:web           # web UI on :5199
```

Other commands:

```bash
pnpm test:server
pnpm test:web
pnpm --dir apps/twin-server typecheck
make help
```

`apps/twin-web/.env.development` sets `TWIN_DEV_UPSTREAM=https://twin.path2v2x.net`, which makes the Next.js dev server proxy `/map-bundles/`, `/catalog/`, `/drive-rigs/`, `/detections/` and `/archive/` to that host; in development, absolute archive URLs advertised by the host are rewritten to those same-origin paths. The UI talks to the twin only over HTTP (`/detections/replay-config`, `/detections/events`, `/detections/history`, `/archive/`); `?at=<ISO>` presets the playhead.

### Web UI configuration

`NEXT_PUBLIC_*` values are inlined at build time.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_TWIN_MAP_MANIFEST_URL` | 3D map manifest, e.g. `/map-bundles/richmond-field-station/3d/manifest.json` |
| `NEXT_PUBLIC_TWIN_MAP_LANES_URL` | lane topology index, e.g. `/map-bundles/richmond-field-station/topology-index.json.gz` |
| `NEXT_PUBLIC_TWIN_CAMERA_RIGS_URL` | pole camera rig JSON, e.g. `/drive-rigs/richmond.json` |
| `NEXT_PUBLIC_TWIN_HOME_URL` | external home link in the header |
| `TWIN_DEV_UPSTREAM` | development only: proxy `/map-bundles/`, `/catalog/`, `/drive-rigs/`, `/detections/` and `/archive/` to this origin |

### Footage player

`apps/twin-web/app/footage/archive-player.ts` plays one camera through a single `<video>` element; the twin's camera tiles and split-view pane (`app/twin/CameraFeed.tsx`) and the detection review (`app/footage/FootagePlayer.tsx`) both use it. Each footage window is one MediaMTX `/get?format=fmp4` request, made at the archive offset the twin server measured at the window's start (`app/footage/archive-offsets.ts`; each camera's offsets for the past hour load once per page and are shared by every view of that camera), and streamed into a shared MediaSource at its detection-time position, so scrubbing inside loaded footage is a `currentTime` change and loading new footage keeps the last frame on screen. A detection's footage is requested as soon as the pointer has rested on its timeline block for 100 ms or presses it (`requestFootageEarly`); the player that then asks for the same window takes over that response, so a click usually finds the detection's first frame already loaded (measured from path-pc: 60–70 ms from click to that frame on `/review`, 120–160 ms in the twin, where the split view also resizes the 3D canvas; the first split in a fresh browser took about 350 ms). The twin's tiles follow its playhead or simulation clock, which the twin already settles while scrubbing, so each tile loads its window at once: a held tile shows the clock's instant (strip tiles load 4 s, the split-view pane a full 30 s window), and a playing tile runs on its own and is moved back to the clock when the two drift more than 0.5 s apart. In the detection review a detection loads from the whole second of its first detection, the whole detection but at least 30 s and at most 60 s; a click outside detections or an arrow key moves the playhead to exactly that instant, keeps playing or paused as it was, and loads 30 s from that second at once, while a drag pauses until release and loads once the pointer has settled for 120 ms. While new footage loads, the current frame holds instead of playing on from the old instant. Whenever the instant to show has not loaded (after a jump, or when playback outruns the loaded footage, reported by the video's `waiting` event), the player's status is `loading`, and every footage view dims the frame under a spinner (`app/footage/FootageLoading.tsx`; strip tiles drop the "Loading footage" label). The indicator fades in only after 300 ms, so footage that loads at once never flashes it. Windows start where the picture is needed because every byte before the first shown frame delays it; once a window has loaded, the 10 s before it is fetched in the background so stepping back stays instant. Each window is clipped to its span (`appendWindowEnd`), so it never overwrites the keyframe that starts footage loaded after it. During playback the next 30 s is fetched 8 s before the loaded footage runs out; at most 4 minutes stay buffered. MediaMTX starts a clip at the keyframe before the requested second (keyframes every 3 s, so up to ~1.4 MB of pre-roll) and stamps those pre-roll frames at the requested time, so media time maps exactly to wall time. If a window ends before the requested instant (a recording gap or relay restart), it is requested again from that instant. `format=mp4` (non-fragmented) cannot be streamed into MediaSource.

### Twin server configuration

| Variable | Default | Purpose |
|---|---:|---|
| `TWIN_WS_PORT` | `8765` | `/twin`, `/drive`, and `/camera-feeds` WebSockets |
| `TWIN_HTTP_PORT` | `8090` | health, MJPEG streams, and detection history APIs |
| `TWIN_MAP_BUNDLE` | `assets/richmond-field-station/bundle` | logical map bundle: `map.xodr`, `topology-index.json.gz`, `signals.geojson.gz`, `derived/{topology-derived,locations}.json.gz` (no 3D tiles; see `derived/map-intel-build-receipt.json`) |
| `TWIN_SESSION_EPOCH_SECONDS` | `600` | live world re-root interval |
| `TWIN_SYNC_LOCAL` | `0` | enable local detection polling |
| `TWIN_DETECTIONS_URL` | `http://127.0.0.1:8091/detections/latest` | co-perception summary endpoint |
| `TWIN_POLL_HZ` | `10` | local summary polls per second |
| `TWIN_HISTORY_DB` | `/var/lib/v2x-twin/detections.sqlite` | SQLite history database (`:memory:` is suitable for tests) |
| `TWIN_HISTORY_RETENTION_HOURS` | `72` | history retention and replay window |
| `TWIN_PUBLIC_HTTP_ORIGIN` | unset | public origin used to advertise absolute history URLs |
| `TWIN_ARCHIVE_URL_TEMPLATE` | unset | MediaMTX `/get` template with `{channel}`, `{start}`, and `{duration}`; must request `format=fmp4` |
| `TWIN_ARCHIVE_LIST_URL_TEMPLATE` | unset | MediaMTX `/list` template with `{channel}`, `{start}`, and `{end}`, used to hatch recording gaps |
| `TWIN_ARCHIVE_OFFSET_SECONDS` | `0` | seconds added to detection timestamps to reach archive timestamps where the server has not measured the offset (see below) |
| `TWIN_CAMERA_SOCKET_PATH` | unset | read live camera frames from the co-perception output socket instead of per-channel ffmpeg inputs |
| `TWIN_CAMERA_URL_TEMPLATE` | `rtsp://127.0.0.1:8554/{channel}` | ffmpeg input URL template when no camera socket is set |
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

`ts` is calibrated capture epoch seconds. Camera summaries more than eight
seconds old or more than five seconds in the future are ignored. Every
accepted camera frame is persisted once by `(camera, ts)` in
`TWIN_HISTORY_DB`, including empty frames; each stored/mirrored detection
needs an `object_id` and `gps_location.lat`/`gps_location.lon`. The history
and coverage APIs are documented in
[docs/twin-protocol-v2.md](docs/twin-protocol-v2.md).

## Camera source contract

With `TWIN_CAMERA_SOCKET_PATH` set (path-rfs uses `/tmp/coperception_output.sock`), live frames for all channels are read from the co-perception output socket; no ffmpeg or RTSP relay is involved.

Otherwise `TWIN_CAMERA_URL_TEMPLATE` is substituted once per channel using `ch1` through `ch4`. Examples:

- `rtsp://127.0.0.1:8554/{channel}` for MediaMTX or go2rtc;
- `http://127.0.0.1:8081/{channel}` for a local HTTP stream source.

ffmpeg uses `-rtsp_transport tcp` for `rtsp://` URLs. If a live input exits or cannot produce frames, the server falls back to the recorded footage loop and retries the local live source after 10 s (doubling per consecutive frameless failure, capped at 2 min). Clients receive MJPEG at `/streams/ch1.mjpg` through `/streams/ch4.mjpg` or multiplexed binary frames at `/camera-feeds`. The web UI does not use these live feeds; it plays MediaMTX recordings through `/archive/`.

## Pole camera rigs

`config/drive-rigs/richmond.json` is the calibrated rig for RFS Mast 1 (signal feature 372): per channel heading, mount pitch, mount height, intrinsics and extrinsic corrections. The web UI's camera strip uses it to look through each pole camera. nginx serves it at `/drive-rigs/richmond.json` (see `deploy/nginx-twin.conf`), which is what `NEXT_PUBLIC_TWIN_CAMERA_RIGS_URL` points at; commit calibration changes to this file.

## Camera archive paths

MediaMTX on path-rfs (`/etc/v2x-camera/mediamtx.yml`) carries two streams per camera, both published by co-perception relays: `chN` is the annotated feed (`jpark-bbox-relay@`, boxes drawn on the frames co-perception detected on), which the twin and the drive dashboard show, and `chN_raw` is the clean pre-annotation backup (`jpark-raw-relay@`). Each MediaMTX path must have exactly one publisher. The drive repository's raw demux relay `v2x-camera-relay@` also targets `chN`; it is disabled on path-rfs. While it ran alongside the annotated relay (after the 2026-10-13 reboot), the two replaced each other every 2–3 s and cut the archive into ~2 s pieces alternating between raw and annotated footage.

MediaMTX lists every recording file of a path on each playback request, so a fragmented archive slows every footage request (about 9 µs per file). The relay fight's pieces (3–6 s files, about 25,000 per camera, 2026-10-20 17:41 to 2026-10-21 19:32 PDT) made `/get` wait 230–250 ms before answering; they were deleted on 2026-10-22 (file names in `/root/deleted-archive-pieces-20261022.txt` on path-rfs), and with 15-minute files `/get` answers in about 7 ms. A recording directory (`/mnt/archive/v2x-camera/recordings/chN`) holding far more than the ~290 files of 72 hours means a path has been republished repeatedly.

## path-rfs deployment

On path-rfs the CARLA drive server (`path2v2x/v2x-drive`) owns `:8765` and `:8090`, so `scripts/systemd/v2x-twin-server.service` runs the twin with:

```text
TWIN_WS_PORT=8865
TWIN_HTTP_PORT=8190
TWIN_SYNC_LOCAL=1
TWIN_DETECTIONS_URL=http://127.0.0.1:8091/detections/latest
TWIN_POLL_HZ=10
TWIN_HISTORY_DB=/var/lib/v2x-twin/detections.sqlite
TWIN_HISTORY_RETENTION_HOURS=72
TWIN_PUBLIC_HTTP_ORIGIN=https://twin.path2v2x.net
TWIN_ARCHIVE_URL_TEMPLATE=https://twin.path2v2x.net/archive/get?path={channel}&start={start}&duration={duration}&format=fmp4
TWIN_ARCHIVE_LIST_URL_TEMPLATE=https://twin.path2v2x.net/archive/list?path={channel}&start={start}&end={end}
TWIN_ARCHIVE_OFFSET_SECONDS=0.6
TWIN_CAMERA_URL_TEMPLATE=rtsp://127.0.0.1:8554/{channel}
TWIN_CAMERA_SOCKET_PATH=/tmp/coperception_output.sock
```

The recorded (annotated) streams are timestamped when a frame reaches the relay (`jpark-bbox-relay@`, ffmpeg `-use_wallclock_as_timestamps`), after co-perception has processed it, and MediaMTX dates each 15-minute recording file by when its first frame arrives. So footage runs behind detection timestamps by co-perception's latency (0.05–0.4 s measured), plus, in the first file after a relay starts, however long its ffmpeg took to send that first frame. Until 2026-10-22 21:20 UTC the relay's ffmpeg probed about 2 s of input before encoding (measured 2.0–2.1 s locally with its exact arguments), so the first file after each relay start ran 1.5–5 s behind while later files were within 0.2 s. Reading the capture clock burned into the frames (top right, same timebase as detection history) against archive time showed this: 4.2–5.0 s on 2026-10-21 19:32–19:46 PDT, 0.5–0.7 s after; 1.6–2.4 s on 2026-10-22 13:38–13:53 and 14:02–14:17, about 0 s from 13:54. The relay (`scripts/relay_broadcast_to_rtsp.py`, an untracked file in jpark's co-perception checkout on path-rfs; backup at `/root/relay_broadcast_to_rtsp.py.bak-20261022`) now passes `-probesize 32 -analyzeduration 0` (start-up 0.15 s). The twin server measures co-perception's latency: it reads the same socket as the relay, takes each annotated frame's arrival time minus the capture time sent just before it, and stores each capture second's median per camera (`/detections/archive-offsets`). The web UI fetches every footage window at the offset measured at the window's start, so a clicked detection opens on its first annotated frame; after the relay fix the burned clock and the measurement agreed within 0.1 s on all four cameras. `TWIN_ARCHIVE_OFFSET_SECONDS` applies only where nothing was measured (before 2026-10-22 21:12 UTC, or with history off); first files recorded before the relay fix keep their start-up error. To check the measurement, fetch 10 s of `/archive/get?...&format=fmp4` per camera, read the burned clock at media t = 2, 5 and 8 s (`ffmpeg -ss <t> ... -vf crop=330:34:950:0`), and compare the archive start plus t minus that clock with `/detections/archive-offsets` at the same time.

### Deploying

```bash
git push origin main
scripts/deploy.sh                 # twin server, units, nginx vhost
scripts/deploy.sh --web           # also build and restart the web UI
scripts/deploy.sh --perception    # also restart v2x-perception (co-perception)
scripts/deploy.sh --dry-run       # print the plan
```

The script fast-forwards `/home/path/v2x-digital-twin` to `origin/main`, runs
`pnpm install --frozen-lockfile` when the lockfile changed, installs
`scripts/systemd/*.service`, `deploy/v2x-twin-web.service` and
`deploy/nginx-twin.conf`, restarts `v2x-twin-server` and checks
`127.0.0.1:8190/health` plus the public `/detections/coverage` route. `--web`
builds `apps/twin-web` with `/etc/v2x-twin-web.env` exported, then restarts
`v2x-twin-web` (`next start` on loopback `:5199`) and checks the public `/`.
Rollback: check out the previous commit on `main`, push, redeploy.

`v2x-twin-server.service` has `StateDirectory=v2x-twin`, which creates
`/var/lib/v2x-twin` (the 72-hour detection history) owned by the `path`
service user. Co-perception installation, health checks, and measured resource
use are documented in [docs/perception-on-path-rfs.md](docs/perception-on-path-rfs.md).

`deploy/nginx-twin.conf` keeps the twin WebSockets on `:8865`, proxies health,
camera streams, and `/detections/` to `:8190`, exposes MediaMTX playback under
`/archive/`, serves browser map bundles (3D tiles, lane topology, signals) at
`/map-bundles/` from `/var/www/v2x-twin-map-bundles/`, serves actor models
(`/catalog/`, the content-hashed GLBs named in `@simforge-oss/asset-catalog`)
from `/var/www/v2x-twin-catalog/`, serves the camera rig at
`/drive-rigs/richmond.json`, and proxies everything else to the web UI on
loopback `:5199`.

First-time setup: copy `deploy/twin-web.env.example` to `/etc/v2x-twin-web.env`,
place the map bundles under `/var/www/v2x-twin-map-bundles/` and the catalog
models under `/var/www/v2x-twin-catalog/`, symlink the vhost into
`sites-enabled`, then run `scripts/deploy.sh --web`.

Protocol details are in [docs/twin-protocol-v2.md](docs/twin-protocol-v2.md).
