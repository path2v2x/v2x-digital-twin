# Twin protocol v2

## Scope

`apps/twin-server` owns one shared SimForge OSS world and exposes control, truth, camera, and health interfaces. Historical lineage: protocol v2 replaced a retired CARLA bridge; that runtime is not present or used.

## Endpoints

| Transport | Endpoint | Content |
|---|---|---|
| WebSocket | `ws://<host>:<TWIN_WS_PORT>/twin` | binary truth frames plus JSON twin metadata and commands |
| WebSocket | `ws://<host>:<TWIN_WS_PORT>/drive` | binary truth frames plus JSON drive commands and replies |
| WebSocket | `ws://<host>:<TWIN_WS_PORT>/camera-feeds` | multiplexed binary JPEG frames plus feed-state JSON |
| HTTP | `http://<host>:<TWIN_HTTP_PORT>/health` | server, engine, mode, and per-channel feed status |
| HTTP | `http://<host>:<TWIN_HTTP_PORT>/streams/ch{1..4}.mjpg` | multipart MJPEG |

The default ports are 8765 and 8090. `TWIN_WS_PORT` and `TWIN_HTTP_PORT` override them. path-rfs uses 8865 and 8190 because the drive application owns the default ports.

## Truth frames

The server forwards binary scene-state truth from `@simforge-oss/training-env` without re-encoding it. All connected `/twin` and `/drive` clients observe the same world. A client should ignore binary data it does not understand rather than treating it as JSON.

## `/twin` JSON messages

On connection the server sends metadata that includes:

- map identity and digest;
- camera calibration and stream URLs;
- current replay/live status;
- server clock and feed states.

A clock message follows once per second. Supported commands include live/replay switching, replay clock control, and camera or scenario-facing operations implemented by `TwinConnection`. Unknown commands return an error object and do not mutate the world.

## `/drive` JSON messages

Each `/drive` connection owns its ego actor and session-scoped placed objects. The shared world continues ticking at a fixed step. The protocol supports vehicle selection, control updates, teleport, weather, traffic profiles, scenario templates, trajectories, zones, reconstruction, and status queries.

Drive-protocol positions use the map bundle's legacy flat-earth frame: x is east and y is negated northing. Scene-state uses x east, z negated northing, and y up, so protocol `[x,y]` maps to scene `{x,z}`. Protocol yaw is clockwise degrees and scene heading is radians.

OpenSCENARIO execution is not supported. `list_scenarios` and `load_scenario` operate on native engine templates under `apps/twin-server/assets/scenarios`.

## Local detections

Set `TWIN_SYNC_LOCAL=1` to poll `GET $TWIN_DETECTIONS_URL` at `TWIN_POLL_INTERVAL` seconds. The response contract owned by `path2v2x/co-perception` is:

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

`ts` is epoch seconds. The server ignores camera summaries older than eight seconds or more than five seconds in the future. Accepted object types are `car`, `truck`, `bus`, and `person`; a detection without `object_id`, `gps_location.lat`, or `gps_location.lon` is ignored. Tracks expire after `TWIN_DESPAWN_SECONDS` without a fresh observation.

The sync status object includes `tracks`, `actors`, `poll_failures`, `detections_url`, `mode`, `replay_supported`, `replay_clock`, and mirrored objects. A mirrored object exposes its current scene pose in `transform`.

## Recorded replay

`TWIN_RECORDED_DETECTIONS` points to a JSON array or JSONL file of detection records using the same `gps_location.lat`/`gps_location.lon` shape. Replay speed is clamped to 0.25 through 8 times real time. Replay is available only when the recorded file contains data.

## Camera feeds

`TWIN_CAMERA_URL_TEMPLATE` defaults to `rtsp://127.0.0.1:8554/{channel}`. The server substitutes `{channel}` with `ch1` through `ch4` and starts one ffmpeg process per channel. RTSP inputs use TCP transport; HTTP and other ffmpeg-supported local URLs are passed directly.

If a live input exits, the server starts the recorded-footage replay and retries live input after 10 s, doubling per consecutive frameless failure up to 2 min. Set `TWIN_LIVE_FEEDS=0` to use recorded footage only. Feed states are `starting`, `live`, or `replay`.

The `/camera-feeds` binary envelope is:

```text
bytes 0..3   ASCII SFCF
byte 4       version (1)
byte 5       channel number (1..4)
byte 6       mode (0 starting, 1 live, 2 replay)
byte 7       reserved
bytes 8..N   JPEG payload
```

A JSON `camera_feed_states` message reports the current mode map. Backpressured WebSocket clients skip stale images rather than building an unbounded queue.

## Local publication

The server writes local JSON under `TWIN_PUBLISH_DIR`:

- `api/state.json` at `TWIN_PUBLISH_STATE_INTERVAL` seconds;
- `api/map-data.json` hourly;
- `map_data/road_network.json` hourly.

Publication performs no remote upload. Per-object snapshot rendering is outside this server's scope.

## Shutdown

SIGINT and SIGTERM stop publication and detection timers, terminate camera ffmpeg children, close WebSocket clients and listeners, and stop the world session.
