# V2X Digital Twin

Digital twin for the Richmond Field Station V2X deployment. The twin server owns simulation truth, mirrors detections from the local co-perception service, records detection history for replay, and serves drive control, truth frames, and camera feeds. The web UI is a detection review page: the past hour of detections on one timeline and, for any instant, the annotated footage of a pole camera (co-perception draws the boxes on the frames it detected on). CARLA is not used by this repository or its runtime.

## Architecture

| Component | Responsibility | Default interface |
|---|---|---|
| `apps/twin-server` | Shared simulation world, drive commands, truth publication, 72-hour detection history/replay, local detection mirroring, camera relay | WS `:8765` at `/twin`, `/drive`, `/camera-feeds`; HTTP `:8090` at `/health`, `/streams/`, `/detections/` |
| `apps/twin-web` | Detection review (Next.js): one row of detected events over the past hour across all cameras, colour-coded by kind, with recording gaps hatched; the selected camera's annotated footage fills the page. Click an event to play it from just before its first detection on its busiest camera; click or drag the timeline to scrub (wheel zooms, ruler drag pans); Space plays/pauses, ←/→ step 1 s, 1–4 switch camera; `?at=<ISO>&camera=chN` opens a given instant | HTTP `:5199` |
| `apps/dev-console` | Low-level `/drive` protocol console | Vite development server |

`path2v2x/co-perception` is the only perception implementation. It is a separate repository and process.

The world session runs in live mode and is re-rooted onto a fresh engine session every `TWIN_SESSION_EPOCH_SECONDS` (600 s) so spawn cost does not grow with uptime.

## Vendored SimForge OSS packages

The twin server's simulation engine, map, and scenario libraries are consumed as a frozen fork of `SimForgeinc/simforge-oss`: packed tarballs committed under `vendor/simforge-oss`, built from commit `c7277f44` and recorded in `vendor/simforge-oss/LOCK.json`. Nothing is fetched from a registry and nothing is contributed back upstream. The `@simforge-oss/*` package names are kept as-is. The web UI uses none of them.

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

`apps/twin-web/.env.development` sets `TWIN_DEV_UPSTREAM=https://twin.path2v2x.net`, which makes the Next.js dev server proxy `/detections/` and `/archive/` to that host; in development, absolute archive URLs advertised by the host are rewritten to those same-origin paths. The UI talks to the twin only over HTTP: `/detections/replay-config` (archive templates and offset), `/detections/events`, and the MediaMTX archive under `/archive/`. It has no build-time configuration.

### Footage player

`apps/twin-web/app/review/archive-player.ts` plays one camera through a single `<video>` element. Each footage window (a clicked event ± 5 s, at most 60 s, or 30 s from a timeline click) is one MediaMTX `/get?format=fmp4` request streamed into a shared MediaSource at its wall-clock position, so scrubbing inside loaded footage is a `currentTime` change and loading new footage keeps the last frame on screen. During playback the next 30 s is fetched 8 s before the loaded footage runs out; at most 4 minutes stay buffered. MediaMTX starts a clip at the keyframe before the requested second and stamps those pre-roll frames at the requested time, so media time maps exactly to wall time. `format=mp4` (non-fragmented) cannot be streamed into MediaSource.

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
| `TWIN_ARCHIVE_OFFSET_SECONDS` | `0` | offset added to replay clip start times to map detection timestamps to archive timestamps |
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

## Camera archive paths

MediaMTX on path-rfs (`/etc/v2x-camera/mediamtx.yml`) carries two streams per camera, both published by co-perception relays: `chN` is the annotated feed (`jpark-bbox-relay@`, boxes drawn on the frames co-perception detected on), which the twin and the drive dashboard show, and `chN_raw` is the clean pre-annotation backup (`jpark-raw-relay@`). Each MediaMTX path must have exactly one publisher. The drive repository's raw demux relay `v2x-camera-relay@` also targets `chN`; it is disabled on path-rfs. While it ran alongside the annotated relay (after the 2026-10-13 reboot), the two replaced each other every 2–3 s and cut the archive into ~2 s pieces alternating between raw and annotated footage.

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
TWIN_ARCHIVE_OFFSET_SECONDS=6
TWIN_CAMERA_URL_TEMPLATE=rtsp://127.0.0.1:8554/{channel}
TWIN_CAMERA_SOCKET_PATH=/tmp/coperception_output.sock
```

The recorded (annotated) streams are timestamped when a frame reaches the relay, after co-perception has processed it, so footage runs about 6 s behind detection timestamps. `TWIN_ARCHIVE_OFFSET_SECONDS=6` was measured by matching the burned-in boxes against detection history (6 s median over 10 events, 6–8 s typical); re-measure it if the pipeline latency changes.

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
`/archive/`, and proxies everything else to the web UI on loopback `:5199`.

First-time setup: copy `deploy/twin-web.env.example` to `/etc/v2x-twin-web.env`,
symlink the vhost into `sites-enabled`, then run `scripts/deploy.sh --web`.

Protocol details are in [docs/twin-protocol-v2.md](docs/twin-protocol-v2.md).
