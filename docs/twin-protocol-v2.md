# Twin Protocol v2 — SimForge twin-server wire contract

Status: **v2 contract, additive-only.** Owner: TwinServer (apps/twin-server/).
Later revisions may ADD messages/fields; existing names and shapes never change.

The server is `apps/twin-server` (TypeScript, SimForge engine). It replaces the
CARLA `digital_twin_bridge` (apps/bridge/ — reference only, deleted in Wave 3).

## Transports

| Surface | Where | What |
|---|---|---|
| WebSocket | `ws://<host>:8765/drive` | driving sessions, world control (JSON text) + binary `truth_frame` |
| WebSocket | `ws://<host>:8765/twin` | twin viewers: replay/live clock control (JSON text) + binary `truth_frame` |
| HTTP | `http://<host>:8090/streams/ch{1..4}.mjpg` | live site cameras via KVS HLS (multipart MJPEG); recorded-loop fallback |
| HTTP | `http://<host>:8090/health` | `{status:"ok"}` liveness |

Ports: `TWIN_WS_PORT` (default **8765**), `TWIN_HTTP_PORT` (default **8090**).

## Binary: `truth_frame` (replaces ALL v1 JPEG streaming)

v1 streamed server-rendered JPEG (drive RGB frames and `twin_frame`+JPEG).
v2 sends **no pixels**. Every binary WebSocket message on `/drive` and `/twin`
is one engine truth frame, relayed **verbatim** from the SimForge world-session
truth stream:

```
+----------------------+----------------------------------+
| payloadBytes: u32 LE | msgpack(TruthFrame)              |
+----------------------+----------------------------------+
```

Framing, `TruthFrame` schema, ordering, atomicity and backpressure are frozen
by the engine doc `docs/truth-stream-wire.md` (SimForgeinc/simforge@22480b76).
Frames relayed to concurrent clients are byte-identical; the client
reconstructs frames with `TruthStreamClient.push(chunk)` from
`@simforge/training-env` and renders pixels locally (Three.js viewer).
A captured sample lives at `fixtures/truth-frame-sample.bin` (real bytes,
one framed message).

Scene frame: scene-state.v1 y-up; `x` = easting, `z` = negated northing around
the map's XODR geoReference origin (identical numeric values to the legacy
CARLA world frame of `geo_utils.py`; see engine
`docs/engineering/v2x-coordinate-contract.md`). All JSON `pos` fields below
remain in that same legacy frame: `pos[0]=x`, `pos[1]=z` (CARLA y), `pos[2]=0`.
Yaw degrees in JSON = `atan2(z, x)` of the motion/facing direction —
numerically identical to legacy CARLA yaw.

Map identity: every consumer must check
`{mapId: "richmond-field-station", xodrSha256: "80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643"}`
(sent in `twin_cameras` and `map_status`).

## `/drive` — JSON messages

Request/response: every client text message gets exactly one JSON reply
(same as v1). Additional server-initiated pushes: none on /drive (alerts ride
on telemetry, as in v1). Unknown types → `{"type":"error","message":...}`.

### Session lifecycle (preserved)

| → request | ← response |
|---|---|
| `{"type":"server_status"}` | `{"type":"server_status","active_sessions":N,"this_session_active":bool}` |
| `{"type":"start_session","start":ISO,"end":ISO,"vehicle"?:bp}` | `{"type":"session_ready","vehicle_id":str,"objects_count":N,"sensor_actor_ids":[],"scene_actor_ids":[...],"owned_actor_ids":[...]}` |
| `{"type":"control","s":steer,"t":throttle,"b":brake,"r"?:reverse}` | `{"type":"telemetry",...}` (below) |
| `{"type":"respawn"}` | `{"type":"respawned","pos":[x,y,z],"vehicle_id":str}` |
| `{"type":"teleport","request_id":str,"x":m,"y":m,"z"?:m,"yaw"?:deg}` | `{"type":"teleported","success":true,"request_id":str,"pos":[x,y,z],"yaw":deg,"snapped_to_road":bool,"vehicle_id":str}` or `{"type":"teleport_error","success":false,"request_id":str,"message":str}` |
| `{"type":"end_session"}` | `{"type":"session_ended"}` |

v2 notes (additive):
- `vehicle_id` is the engine actor id (string, e.g. `"ws:0001"`), not a CARLA
  int. Respawn/teleport allocate a **new** actor id (the engine never reuses
  ids); the reply's `vehicle_id` is authoritative — clients must rebind.
- `start`/`end` (historical reconstruction window) reconstruct recorded
  detections as ghost actors when a recorded-detections file is configured;
  `objects_count` counts them. With no recording configured it is 0.
- Control semantics: zero-order hold (last control persists), applied at the
  next 20 Hz tick boundary — one-tick latency. Throttle/brake/steer ∈ [0,1]/
  [0,1]/[-1,1] onto the engine's dynamic-v1 vehicle model.

### Telemetry (preserved shape; response to every `control`)

```json
{"type":"telemetry","speed":kmh,"gear":1,"pos":[x,y,z],"rot":[pitch,yaw,roll],
 "steer":s,"throttle":t,"brake":b,
 "nearby_actors":[{"id":str,"pos":[x,y],"yaw":deg,"type":"dynamic"|"traffic"|"other"}],
 "dynamic_actors":[{"actor_id":str,"blueprint":str,"name":str,"pos":[x,y,z],"yaw":deg,
                    "geofence_radius":m,"message":str,"autopilot":true}],
 "detections":[...],
 "v2x_alerts":[{"id":str,"message":str,"signal_type":"warning","distance":m}]}
```

- `gear`: 1 forward, -1 reverse (engine motion direction).
- `nearby_actors`: every non-ego vehicle-class actor within 250 m.
- `detections` — **truth-derived** (v1 derived these from ego-attached
  semantic+depth camera pairs; v2 synthesizes the same shape from engine
  ground truth — see “detections mapping” below).
- `v2x_alerts` present only when non-empty. EVA geometry ported verbatim from
  `drive_server.py` (`_check_emergency_vehicle_proximity`,
  `_check_yield_to_firetruck`): firetruck within `EVA_WARNING_DISTANCE_M`
  (20 m) behind-of-ego → `"Firetruck approaching from behind"`; ego blocking
  the truck's forward cone (ahead of truck, lateral ≤ 4 m) for > 10 s →
  `"Yield to clear firetruck path"` with id offset `+1000000`. Zone/geofence
  entry alerts also arrive here (see zones section).

#### telemetry.detections mapping (v1 seg+depth → v2 truth)

v1: eight semantic/depth camera pairs → mask analysis → median depth →
world-projected, deduplicated, tracked records. v2 emits the same record shape
for **all non-ego present actors** (ground truth; no sensor simulation):

```json
{"id":str,"label":"car"|"truck"|"bus"|"motorcycle"|"bicycle"|"pedestrian"|"prop",
 "pos":[x,y,z],"distance":m,"velocity":[vx,vy,vz],"speed_mps":n,"yaw":deg}
```

`label` is the TruthFrame actor class. `distance` is planar range from the
ego. Records sorted by distance ascending. v1's per-camera bbox/pixel fields
are gone (no pixels server-side); the old shape's `pos`/`label`/`distance`
semantics are preserved.

### Maps (preserved)

| → | ← |
|---|---|
| `{"type":"list_maps"}` | `{"type":"map_status","current_map":"richmond-field-station","maps":["richmond-field-station"],"mapId":...,"xodrSha256":...}` |
| `{"type":"set_map","map":id}` | `{"type":"map_set","current_map":id,...}` or `{"type":"error",...}` |

One map ships in v2 (richmond-field-station); `set_map` to it is a no-op ack.

### Object/scenario placement (preserved)

| → | ← |
|---|---|
| `{"type":"list_vehicles"}` | `{"type":"vehicle_list","vehicles":[{"id":bp,"name":str,"wheels":4}]}` |
| `{"type":"list_objects"}` | `{"type":"object_list","objects":[{"id":bp,"name":str}]}` |
| `{"type":"spawn_object","blueprint":bp,"offset"?:m}` | `{"type":"object_spawned","actor_id":str,"blueprint":bp,"pos":[x,y,z],"placed_count":N}` |
| `{"type":"undo_place"}` | `{"type":"object_removed",...}` or `{"type":"undo_empty",...}` |
| `{"type":"spawn_dynamic_actor","blueprint":bp,"geofence_radius"?:m,"message"?:str}` | `{"type":"dynamic_actor_spawned","actor":{...},"count":N}` |
| `{"type":"despawn_dynamic_actor","actor_id":id}` | `{"type":"dynamic_actor_despawned","actor_id":id,"count":N}` |
| `{"type":"despawn_dynamic_actors"}` | `{"type":"dynamic_actors_despawned","count":N}` |
| `{"type":"clear_non_ego_vehicles"}` | `{"type":"non_ego_vehicles_cleared","destroyed":N,"preserved":N,"placed_count":N}` |
| `{"type":"list_scenarios"}` | `{"type":"scenario_list","scenarios":[{"file":str,"name":str,"description":str}]}` |
| `{"type":"load_scenario","file":str}` | `{"type":"scenario_loaded","name":str,"file":str,"zones":[],"spawned":N,"failed":N,"placed_count":N}` |
| `{"type":"save_scenario","name":str,"zones"?:[]}` | `{"type":"scenario_saved","name":str,"file":str,"object_count":N,"zone_count":N}` |
| `{"type":"delete_scenario","file":str}` | `{"type":"scenario_deleted","file":str}` |

- Blueprint ids: engine actor kinds are exposed under their legacy-looking ids
  (`vehicle.car`, `vehicle.truck`, `vehicle.bus`, `vehicle.van`,
  `vehicle.motorcycle`, `vehicle.bicycle`, `walker.pedestrian`,
  `static.prop.box`). `vehicle.carlamotors.firetruck` is preserved verbatim —
  it spawns a truck-class actor tagged `firetruck` and drives the EVA alerts.
- `list_scenarios` lists the migrated engine templates
  (`firetruck-from-south`, `firetruck-from-north`, `sample-npc-cruise`) plus
  any user-saved placement scenarios. `load_scenario` of a migrated template
  instantiates its non-ego roles at their authored poses/routes
  (ScenarioPicker contract).
- `list_xosc_scenarios`/`start_xosc_scenario`/`stop_xosc_scenario` are
  answered with `{"type":"xosc_list","scenarios":[],"status":{"running":false,
  "scenario_runner_configured":false}}` / an explanatory `error`: OpenSCENARIO
  execution was CARLA ScenarioRunner; migrated scenarios are engine templates
  now (use `list_scenarios`/`load_scenario`).

### Traffic presets (preserved)

| → | ← |
|---|---|
| `{"type":"spawn_traffic","preset":"none"|"light"|"medium"|"heavy"|"chaos"}` | `{"type":"traffic_spawned","preset":p,"count":N}` |
| `{"type":"despawn_traffic"}` | `{"type":"traffic_despawned","count":N}` |

Preset names map to the migrated engine ambient-traffic profiles
(`apps/v2x-migration/traffic/*.ambient.json`); counts are the actors actually
placed by the deterministic ambient materializer (bounded by map lane-km, so
smaller than the CARLA vehicle counts on this small site).

### Weather (preserved message, documented gaps)

`{"type":"set_weather","params":{...}}` → `{"type":"weather_set","params":{full safe param set}}`

The 14 CARLA `WeatherParameters` keys are accepted and clamped to the same
`SAFE_WEATHER_LIMITS` as v1; the reply echoes the complete clamped set.
Engine mapping (authored environment): `sun_altitude_angle`+`sun_azimuth_angle`
→ time-of-day; `precipitation` → precipitation; `fog_density`/`fog_distance`
→ fog/visibility; `cloudiness` → overcast. The applied engine environment is
reported in an additive `"applied"` field:
`{"timeOfDay":str,"weather":str}`. Keys with no engine counterpart
(`wind_intensity`, `precipitation_deposits`, `wetness`, scattering/dust
params) are clamped+echoed but have no scene effect — documented gap. Weather
is world-global and rendered client-side from `applied`.

### Zones & geofences (preserved)

`{"type":"sync_v2x_zones","zones":[{"id","name","message","zone_kind","signal_type","polygon":[[lon,lat]...],"color"}]}`
→ `{"type":"v2x_zones_synced","drawn":N}`

Zones are stored server-side (replacing the CARLA debug-draw; the client
renders zones itself). `drawn` counts zones with ≥3 valid vertices and
`signal_type` ≠ `info`, matching v1. Every telemetry tick evaluates, in the
legacy flat-earth frame (verbatim ports of the v1 geometry):
- polygon zones: ego inside polygon (ray-cast point-in-polygon) → v2x_alert
  `{"id":"zone:"+zone.id,"message":zone.message,"signal_type":zone.signal_type,"distance":0}`
- dynamic-actor circular geofences: ego within `geofence_radius` of the actor
  → v2x_alert `{"id":"geofence:"+actor_id,"message":meta.message,
  "signal_type":"warning","distance":d}`

### GPS trajectory playback (preserved)

| → | ← |
|---|---|
| `{"type":"list_trajectories"}` | `{"type":"trajectory_list","trajectories":[{"file","waypoints","duration"}],"status":{...}}` |
| `{"type":"upload_trajectory","name":str,"data":[...]}` | `{"type":"trajectory_uploaded","file":str}` |
| `{"type":"start_trajectory","file":str,"vehicle"?:bp}` | `{"type":"trajectory_started","vehicle_id":str,"duration":s,"waypoints":N,"name":str}` |
| `{"type":"stop_trajectory"}` | `{"type":"trajectory_stopped","stopped":bool}` |
| `{"type":"trajectory_status"}` | `{"type":"trajectory_status","active":bool,"name"?,"elapsed"?,"duration"?,"vehicle_id"?,"finished"?}` |

Both v1 input formats accepted:
`[{object_id,timestamp_utc,gps_location:{latitude,longitude},object_type?}]`
(most-frequent object_id wins) and `[{t,lat,lon}]`. WGS-84 → legacy
flat-earth; playback is the engine timed-route walk: the actor hits each
recorded waypoint at its recorded timestamp (exact scene-space keyframes;
tolerance = one tick, 50 ms). After the final keyframe it brakes and idles,
as v1. Shipped sample: `event1.json` (from `apps/bridge/trajectories/`).

### Camera messages (accepted, degraded)

`camera_switch`/`set_camera_settings` have no server-side pixels to act on;
the server acks (`camera_switched` / `camera_settings_set` echoing stored
values) so v1 dashboards keep working; the client owns its own Three.js
cameras.

## `/twin` — JSON messages

On connect the server immediately sends (in order):
1. `twin_hello` (preserved):
   `{"type":"twin_hello","camera_id":ch|null,"camera_model":{...}|null,"width":2560,"height":1920,"fps":20,"cameras":["ch1","ch2","ch3","ch4"],"rig":{...},"sync":{...}}`
   (`?cam=chN` query selects `camera_id`, default ch1; `?control=1` →
   `camera_id:null`.) `fps` describes the truth stream rate (20 Hz), not JPEG.
2. **NEW** `twin_cameras`:

```json
{"type":"twin_cameras",
 "mapId":"richmond-field-station",
 "xodrSha256":"80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643",
 "site":{"lat":37.91560117034595,"lon":-122.33478756387032,"name":"Richmond Field Station"},
 "cameras":[
   {"id":"ch1","device_id":"cam-001-ch1",
    "height_m":7.0,"pitch_deg":-39.2,"yaw_deg":-46.06,"heading_deg":200.0,
    "intrinsics":{"fx":1325.4,"fy":1325.4,"cx":1280.0,"cy":960.0,"width":2560,"height":1920},
    "twin_pose":{"yaw_offset_deg":0.0,"pitch_offset_deg":0.0,"height_offset_m":0.0,"forward_offset_m":0.5},
    "stream_url":"http://<host>:8090/streams/ch1.mjpg"},
   ... ch2 ch3 ch4 ...]}
```

All calibration numbers come verbatim from `config/cameras.json`. The client
derives each twin camera pose: pole at site lat/lon → legacy flat-earth →
scene; camera yaw = `heading_deg + yaw_deg + twin_pose.yaw_offset_deg`
(degrees, legacy CARLA yaw convention), pitch = `pitch_deg +
twin_pose.pitch_offset_deg`, height = `height_m + twin_pose.height_offset_m`,
advanced `forward_offset_m` along yaw (this is `twin_camera_rig.py`'s pose
derivation).

Then binary `truth_frame` messages stream continuously (unless `?control=1`),
and `twin_clock` JSON once per second.

### Control (preserved)

| → | ← |
|---|---|
| `{"type":"twin_replay","start":ISO,"speed"?:0.25..8}` | `twin_mode` or `twin_error` |
| `{"type":"twin_live"}` | `twin_mode` |
| `{"type":"twin_status"}` | `twin_mode` incl. `actors`,`objects` |

- `twin_mode`: `{"type":"twin_mode","mode":"live"|"replay"|"off","replay_supported":bool,"replay_clock":ISO|null,"tracks":N}`
  (+`actors`,`objects` when requested via twin_status).
- `twin_clock`: same payload with `"type":"twin_clock"`, every second.
- `twin_error`: `{"type":"twin_error","message":str}`.
- Replay clock math (verbatim from twin_sync.py):
  `clock = start + (wallNow − wall0) × speed`; speed clamped [0.25, 8];
  start must lie within the past 24 h; a second connection cannot steal an
  active replay; disconnect of the owner returns the twin to live.
- `objects` entries preserve the v1 `_track_status` shape: `{object_id,
  object_type, gps_location, tracked_actor_id, actor_id, actor_present,
  actor_type, carla_transform:{location:{x,y,z},rotation:{pitch,yaw,roll}},
  event_id, detection_timestamp_utc, media_timestamp_utc,
  timestamp_schema_version, media_time_trusted, media_clock, device_id,
  track_id, bbox}` (actor ids are engine actor-id strings).

## Detection mirroring (twin_sync port)

Ghost actors mirror external detections into the shared world. Sources:
1. local perception HTTP `GET {TWIN_DETECTIONS_URL}` (v1 default
   `http://127.0.0.1:8090/detections/latest`), poll 1 s — env
   `TWIN_SYNC_LOCAL=on` to enable (default **off**);
2. cloud detections API, poll 5 s, records
   `{object_id,object_type,gps_location:{latitude,longitude},confidence}` —
   env `TWIN_SYNC_CLOUD=on` + `V2X_API_URL` (default **off**);
3. recorded-detections replay: JSONL/JSON file of the same records
   (`TWIN_RECORDED_DETECTIONS`, sample shipped at
   `apps/twin-server/assets/recorded/event1.json`), driven by the `/twin`
   replay clock.

Semantics ported from `twin_sync.py`: accepted object types
car/truck/bus/person; ghost spawns at the flat-earth detection point (vehicle
types lane-snapped when within 4 m of a lane, else free), moves by
interpolating toward each new fix over the poll interval, derives yaw from the
motion vector when displacement > 1.5 m, expires **12 s** after last sighting
(`TWIN_DESPAWN_SECONDS`), and cloud records older than **300 s** are dropped
at ingest (`V2X_STALE_SECONDS`). Ghosts are engine actors and therefore appear
in every `truth_frame` (class car/truck/bus/pedestrian) — this is verified by
test. Divergence from v1: ghosts ride the engine's dynamic body (steer-rate
limited) instead of transform teleports, so their path to each fix is smooth
rather than piecewise-linear; they are not collision-transparent.

## Publication (uplink port)

Default: **local filesystem** under `TWIN_PUBLISH_DIR`
(default `apps/twin-server/var/publication/`):
- `api/state.json` — `{"objects":[...],"map":{...},"timestamp":ISO}` every 5 s
  (object records preserve the v1 state.json shape: `object_id`,`object_type`,
  `lat`,`lon`,`confidence`,`street_name`,`timestamp_utc`,`snapshot_url`(null),
  `snapshot_timestamp`(null),`last_updated`);
- `api/map-data.json` — `{"geo_ref":{...},"road_network":[[[lat,lon],...],...]}` (1 h cadence);
- `map_data/road_network.json` — same payload at the v1 S3 key layout.

S3 upload happens **only** when `TWIN_S3_BUCKET` is explicitly set (plus
`TWIN_S3_REGION`); no AWS calls otherwise. Per-object snapshot JPEGs
(`snapshots/{object_id}/latest.jpg`) are **out of scope** in v2 — the server
renders no pixels; `snapshot_url` is published as `null`.

## Camera feeds (perception URL shape)

`GET :8090/streams/{ch1..ch4}.mjpg` → `multipart/x-mixed-replace;
boundary=frame`, JPEG parts. This is the URL shape `apps/perception` served
(`process_video.py /streams/{camera}.mjpg`), so FeedCell-style consumers work
unchanged; URLs are advertised in `twin_cameras.cameras[].stream_url`.

Source per channel, in preference order:

1. **LIVE** — the real Richmond site camera, via Kinesis Video Streams HLS.
   Stream name `${TWIN_KVS_STREAM_PREFIX}${channel}` (default
   `v2x-backend-cam-ch1..ch4`) in `TWIN_KVS_REGION` (default `us-west-2`,
   matching `apps/perception/kinesis_utils.py`), resolved with the aws CLI under
   `TWIN_AWS_PROFILE` (default `path`): `get-data-endpoint` →
   `get-hls-streaming-session-url --playback-mode LIVE`. Sessions expire, so an
   ffmpeg exit simply triggers a fresh resolve + relaunch.
2. **REPLAY fallback** — the recorded footage
   (`assets/richmond-field-station/map/richmond-field-station_20260410-185647.mp4`,
   40 s) looped with a distinct per-channel crop, used when live resolution
   fails (no credentials, stream inactive). A 5-minute timer retries live.

Set `TWIN_LIVE_FEEDS=0` to force replay. The active mode per channel is
reported truthfully in `twin_cameras.cameras[].feed_mode` (`live` | `replay` |
`starting`) and at `GET :8090/health` (`feeds`); the web client's feed badge
renders `REAL · LIVE` only when the channel is genuinely live.

## Removed v1 surfaces

- `/test` WebSocket (disabled-by-default HIL echo/upload): dropped.
- Binary JPEG frames on /drive and `twin_frame` JSON+JPEG on /twin: replaced
  by `truth_frame`.
- `set_camera_settings` post-processing attrs: acked, no effect (no server
  pixels).
- OpenSCENARIO ScenarioRunner subprocess: replaced by engine templates.
