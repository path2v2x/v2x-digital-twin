# Drive API developer console

Developer-facing console for the SimForge twin-server `/drive` WebSocket API.
It can spawn a session vehicle, send controls, build input scripts, inject raw
JSON, display returned telemetry, and inspect every WebSocket message.

The console intentionally does not render camera frames. Visual simulation and
MJPEG camera viewing belong to `apps/twin-web`; binary messages on `/drive` are
SimForge truth frames and are shown only in the flight recorder.

## Run

```bash
cd apps/dev-console
npm install
npm run dev
```

The default endpoint is `ws://localhost:8765/drive`. The active contract is
[../../docs/twin-protocol-v2.md](../../docs/twin-protocol-v2.md).
