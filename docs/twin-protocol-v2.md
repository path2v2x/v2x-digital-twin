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
| HTTP | `http://<host>:<TWIN_HTTP_PORT>/detections/coverage` | bucketed historical detection availability |
| HTTP | `http://<host>:<TWIN_HTTP_PORT>/detections/history` | timestamp-ordered historical detections |
| HTTP | `http://<host>:<TWIN_HTTP_PORT>/detections/objects` | per-object summaries over a time range |

The default ports are 8765 and 8090. `TWIN_WS_PORT` and `TWIN_HTTP_PORT` override them. path-rfs uses 8865 and 8190 because the drive application owns the default ports.

## Truth frames

The server forwards binary scene-state truth from `@simforge-oss/training-env` without re-encoding it. All connected `/twin` and `/drive` clients observe the same world. A client should ignore binary data it does not understand rather than treating it as JSON.

## `/twin` JSON messages

On connection, `twin_hello` includes map/camera metadata, current sync status,
and the replay discovery block:

```json
{
  "type": "twin_hello",
  "replay": {
    "retention_hours": 72,
    "archive_offset_seconds": 0,
    "archive_url_template": "https://example.test/archive/get?path={channel}&start={start}&duration={duration}&format=mp4",
    "coverage_url": "https://example.test/detections/coverage",
    "history_url": "https://example.test/detections/history"
  }
}
```

The three URLs are absolute and are all `null` when
`TWIN_PUBLIC_HTTP_ORIGIN` is unset. `archive_url_template` comes from
`TWIN_ARCHIVE_URL_TEMPLATE`; `{channel}`, `{start}`, and `{duration}` are
client-substituted. `archive_offset_seconds` is the finite numeric
`TWIN_ARCHIVE_OFFSET_SECONDS` value (default `0`). Clients add it to the
detection-clock clip start when requesting archive footage; fractional values
preserve subsecond precision.

Send `{"type":"twin_replay","start":"<RFC3339 UTC>","speed":1}` to enter
replay or seek while replaying. Speed `0` pauses; moving speeds are clamped to
0.25 through 8. Send `{"type":"twin_live"}` to return to live operation.
Replay has one controlling connection, cannot begin during an active Drive
session, and is limited to the configured retention window (72 hours by
default).

`twin_mode` and `twin_clock` include `mode`, `replay_supported`,
`replay_clock`, `replay_speed`, and `tracks`. `replay_clock` is an RFC3339 UTC
timestamp. Clock messages run at 4 Hz in replay and 1 Hz in live mode; a
paused replay reports the same clock and `replay_speed: 0`. `twin_status`
returns `twin_mode` with actor/object details. Unknown commands return
`twin_error` without mutating the world.

## `/drive` JSON messages

Each `/drive` connection owns its ego actor and session-scoped placed objects. The shared world continues ticking at a fixed step. The protocol supports vehicle selection, control updates, teleport, weather, traffic profiles, scenario templates, trajectories, zones, reconstruction, and status queries.

Drive-protocol positions use the map bundle's legacy flat-earth frame: x is east and y is negated northing. Scene-state uses x east, z negated northing, and y up, so protocol `[x,y]` maps to scene `{x,z}`. Protocol yaw is clockwise degrees and scene heading is radians.

OpenSCENARIO execution is not supported. `list_scenarios` and `load_scenario` operate on native engine templates under `apps/twin-server/assets/scenarios`.

## Local detections

Set `TWIN_SYNC_LOCAL=1` to poll `GET $TWIN_DETECTIONS_URL` at
`TWIN_POLL_HZ` (10 Hz by default). The response contract owned by
`path2v2x/co-perception` is:

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

`ts` is calibrated capture epoch seconds. The server ignores camera summaries
older than eight seconds or more than five seconds in the future. Each
accepted per-camera summary is transactionally persisted before its
detections are flattened for live mirroring; `(camera, ts)` deduplicates
repeated polls, including empty frames. Accepted mirror types are `car`,
`truck`, `bus`, and `person`; a detection without `object_id`,
`gps_location.lat`, or `gps_location.lon` is not stored or mirrored. Tracks
expire after `TWIN_DESPAWN_SECONDS` without a fresh observation.

The sync status object includes `tracks`, `actors`, `poll_failures`,
`detections_url`, `mode`, `replay_supported`, `replay_clock`,
`replay_speed`, and mirrored objects. A mirrored object exposes its current
scene pose in `transform`.

## Detection history and replay

`TWIN_HISTORY_DB` selects the SQLite database (default
`/var/lib/v2x-twin/detections.sqlite`). It uses WAL mode, retains
`TWIN_HISTORY_RETENTION_HOURS` (72 by default), and prunes every ten minutes.
Replay support is advertised when the database opens. Replay queries
timestamp-indexed history in chunks no wider than 30 seconds. Seeking resets
the ghost tracks and reconstructs the requested instant; replay-time expiry
uses the replay clock, and pause freezes both clock and ghosts.

`GET /detections/history?start=<ISO>&end=<ISO>&limit=<n>` returns ascending
items in the form `{ts,camera,object_id,object_type,confidence,lat,lon}` and
`next`, the timestamp of the next unreturned item. The default limit is 1000
and the maximum is 5000.

`GET /detections/objects?start=<ISO>&end=<ISO>&limit=<n>` returns `{items}`
with one entry per `object_id` seen in the range, ordered by `last_seen`
descending:
`{object_id,object_type,first_seen,last_seen,count,max_confidence,cameras,last_lat,last_lon}`.
The default limit is 200 and the maximum is 1000. The V2X Drive Timeline page
uses this route for its event list.

`GET /detections/coverage?start=<ISO>&end=<ISO>&bucket=<seconds>` returns
`{start,end,bucket_seconds,buckets}`. Each bucket contains
`{start,detections,objects}`, including empty buckets. The default bucket is
300 seconds, the minimum is 10 seconds, and requests over 2000 buckets return
HTTP 400. All three detection routes return JSON errors with HTTP 400 for
invalid parameters.

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
