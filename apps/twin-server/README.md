# twin-server

V2X Digital Twin server. It runs one shared live simulation world on the Richmond Field Station map and serves `/drive`, `/twin`, and `/camera-feeds` over WebSocket and `/health`, `/streams/ch1..4.mjpg`, and `/detections/` over HTTP.

The simulation libraries come from the vendored SimForge OSS archives under `../../vendor/simforge-oss` (frozen at commit `c7277f44`; see the root README). The map bundle defaults to `assets/richmond-field-station/bundle` at the repository root and can be changed with `TWIN_MAP_BUNDLE`.

```bash
pnpm install
pnpm --dir apps/twin-server start
```

`TWIN_WS_PORT` and `TWIN_HTTP_PORT` default to 8765 and 8090. Live camera frames are read from `TWIN_CAMERA_SOCKET_PATH` (the co-perception output socket) when set, otherwise through ffmpeg from `TWIN_CAMERA_URL_TEMPLATE` (default `rtsp://127.0.0.1:8554/{channel}`). Enable the co-perception poller with `TWIN_SYNC_LOCAL=1` and set `TWIN_DETECTIONS_URL` to its `/detections/latest` endpoint. The full variable list is in the root README.

See `../../docs/twin-protocol-v2.md` for the wire contract.
